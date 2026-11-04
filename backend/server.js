const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');


const PATH = '1337';
const PORT = 8080;
const MONGO_URL = 'mongodb://localhost:27017';
const DB_NAME = 'untitled-sns';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const router = express.Router();
let users, contents, follows;

// Images are stored on disk with a random name; only image files are accepted
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  secret: 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 },
}));

/* ---------- Helpers ---------- */

/** Wraps an async route so that thrown errors reach the error handler. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

/** Blocks requests from users who are not logged in. */
function requireLogin(req, res, next) {
  if (!req.session.username) return res.status(401).json({ message: 'Please log in first.' });
  next();
}

/** Hashes a password with scrypt and a per-user random salt. */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** Escapes user input so it can be used safely inside a regular expression. */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds a full URL for a file in the uploads folder, or null when there is none. */
function fileUrl(req, filename) {
  return filename ? `${req.protocol}://${req.get('host')}/${PATH}/uploads/${filename}` : null;
}

/** Turns a stored content document into the JSON the front end expects. */
function formatPost(req, post) {
  return {
    _id: post._id,
    username: post.username,
    text: post.text,
    image: fileUrl(req, post.image),
    createdAt: post.createdAt,
    replies: post.replies || [],
  };
}

/** Formats several posts and attaches each author's current profile photo. */
async function formatPosts(req, posts) {
  // One query for all authors, instead of one query per post
  const names = [...new Set(posts.map((post) => post.username))];
  const authors = await users.find({ username: { $in: names } })
    .project({ username: 1, profilePhoto: 1 }).toArray();
  const photos = new Map(authors.map((a) => [a.username, fileUrl(req, a.profilePhoto)]));

  return posts.map((post) => ({ ...formatPost(req, post), avatar: photos.get(post.username) || null }));
}

/* ---------- Registration and login ---------- */

router.post('/users', wrap(async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Username, email and password are required.' });
  }
  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ message: 'Username needs 3+ characters and password 6+.' });
  }
  if (await users.findOne({ username })) {
    return res.status(409).json({ message: 'That username is already taken.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await users.insertOne({ username, email, salt, passwordHash: hashPassword(password, salt) });
  res.status(201).json({ message: 'Account created.' });
}));

router.get('/login', (req, res) => {
  const username = req.session.username;
  res.json(username ? { loggedIn: true, username } : { loggedIn: false });
});

router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body;
  const user = username && password && await users.findOne({ username });
  if (!user || user.passwordHash !== hashPassword(password, user.salt)) {
    return res.status(401).json({ message: 'Incorrect username or password.' });
  }
  req.session.username = user.username;
  res.json({ message: 'Logged in.', username: user.username });
}));

router.delete('/login', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out.' }));
});

/* ---------- Content ---------- */

router.post('/contents', requireLogin, upload.single('image'), wrap(async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ message: 'A caption is required.' });
  await contents.insertOne({
    username: req.session.username,
    text,
    image: req.file ? req.file.filename : null,
    createdAt: new Date(),
  });
  res.status(201).json({ message: 'Posted.' });
}));

router.post('/contents/:id/replies', requireLogin, wrap(async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ message: 'A reply cannot be empty.' });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid post id.' });

  const result = await contents.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $push: { replies: { username: req.session.username, text, createdAt: new Date() } } }
  );
  if (result.matchedCount === 0) return res.status(404).json({ message: 'Post not found.' });
  res.status(201).json({ message: 'Reply added.' });
}));

// Feed: only posts from users that the logged-in user follows
router.get('/contents', requireLogin, wrap(async (req, res) => {
  const followed = await follows.find({ follower: req.session.username }).toArray();
  const names = followed.map((f) => f.followee);
  const posts = await contents.find({ username: { $in: names } }).sort({ createdAt: -1 }).limit(50).toArray();
  res.json(await formatPosts(req, posts));
}));

// Search posts by caption or author, across all users
router.get('/contents/search', requireLogin, wrap(async (req, res) => {
  const pattern = new RegExp(escapeRegex(String(req.query.q || '')), 'i');
  const posts = await contents.find({ $or: [{ text: pattern }, { username: pattern }] })
    .sort({ createdAt: -1 }).limit(50).toArray();
  res.json(await formatPosts(req, posts));
}));

/* ---------- Following and user search ---------- */

router.post('/follow/:username', requireLogin, wrap(async (req, res) => {
  const target = req.params.username;
  if (target === req.session.username) return res.status(400).json({ message: 'You cannot follow yourself.' });
  if (!await users.findOne({ username: target })) return res.status(404).json({ message: 'User not found.' });
  // Upsert keeps the request idempotent: following twice stores one record
  await follows.updateOne(
    { follower: req.session.username, followee: target },
    { $set: { follower: req.session.username, followee: target } },
    { upsert: true }
  );
  res.json({ message: `You are now following ${target}.` });
}));

router.delete('/follow/:username', requireLogin, wrap(async (req, res) => {
  await follows.deleteOne({ follower: req.session.username, followee: req.params.username });
  res.json({ message: `You unfollowed ${req.params.username}.` });
}));

router.get('/users/search', requireLogin, wrap(async (req, res) => {
  const pattern = new RegExp(escapeRegex(String(req.query.q || '')), 'i');
  const matches = await users.find({ username: { $regex: pattern, $ne: req.session.username } })
    .project({ username: 1 }).limit(30).toArray();
  const followed = await follows.find({ follower: req.session.username }).toArray();
  const followedNames = new Set(followed.map((f) => f.followee));
  res.json(matches.map((u) => ({ username: u.username, following: followedNames.has(u.username) })));
}));

// Profile: counts, photo and posts for one user
router.get('/users/:username', requireLogin, wrap(async (req, res) => {
  const username = req.params.username;
  const user = await users.findOne({ username });
  if (!user) return res.status(404).json({ message: 'User not found.' });

  const me = req.session.username;
  const [followers, following, isFollowing] = await Promise.all([
    follows.countDocuments({ followee: username }),
    follows.countDocuments({ follower: username }),
    follows.findOne({ follower: me, followee: username }),
  ]);

  // Posts are only shown for yourself or for users you follow
  const canSee = username === me || Boolean(isFollowing);
  const posts = canSee ? await contents.find({ username }).sort({ createdAt: -1 }).toArray() : [];

  res.json({
    username,
    followers,
    following,
    isOwner: username === me,
    profilePhoto: fileUrl(req, user.profilePhoto),
    posts: await formatPosts(req, posts),
  });
}));

// Replace the logged-in user's profile photo
router.put('/users/photo', requireLogin, upload.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Please choose an image file.' });
  await users.updateOne(
    { username: req.session.username },
    { $set: { profilePhoto: req.file.filename } }
  );
  res.json({ message: 'Profile photo updated.', profilePhoto: fileUrl(req, req.file.filename) });
}));

/* ---------- Server start-up ---------- */

app.use(`/${PATH}/uploads`, express.static(UPLOAD_DIR));
app.use(`/${PATH}`, router);

// Serves the front end from the same origin at http://localhost:8080/
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Last-resort handler: always replies in JSON
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Server error. Please try again.' });
});

MongoClient.connect(MONGO_URL).then(async (client) => {
  const db = client.db(DB_NAME);
  users = db.collection('users');
  contents = db.collection('contents');
  follows = db.collection('follows');
  await users.createIndex({ username: 1 }, { unique: true });
  await follows.createIndex({ follower: 1, followee: 1 }, { unique: true });
  app.listen(PORT, () => console.log(`Web service running at http://localhost:${PORT}/${PATH}/`));
}).catch((error) => {
  console.error('Could not connect to MongoDB:', error.message);
  process.exit(1);
});

