// Replace with your own PATH: every web service path starts with it
const PATH = '1337';
const API = `http://localhost:8080/${PATH}`;

let currentUser = '';

// Shown for users who have not uploaded a profile photo
const DEFAULT_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0f7b6c"/>' +
  '<circle cx="50" cy="38" r="18" fill="#fff"/><path d="M14 100a36 36 0 0 1 72 0z" fill="#fff"/></svg>'
);

const $ = (id) => document.getElementById(id);

/**
 * Sends a request to the web service and returns the parsed JSON.
 * Pass a plain object for JSON bodies or a FormData object for file uploads.
 * Throws an Error with the server's message when the request fails.
 */
async function api(method, path, body) {
  const options = { method, credentials: 'include', headers: {} };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(API + path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || 'Something went wrong. Try again.');
  }
  return data;
}

/** Accepts either a bare array or an object that wraps the array. */
const toList = (data) => (Array.isArray(data) ? data : data.contents || data.users || data.results || []);

/** Shows a message in the given element, styled as an error unless isOk is true. */
function showMessage(element, text, isOk = false) {
  element.textContent = text;
  element.classList.toggle('ok', isOk);
}

/** Creates an element with an optional class and text (text is never parsed as HTML). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/* ---------- View switching ---------- */

function showAuth() {
  $('app-view').hidden = true;
  $('auth-view').hidden = false;
}

function showApp(username) {
  currentUser = username;
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
  $('profile-btn').textContent = username;
  loadFeed();
}



/* ---------- Registration and login ---------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('login-form').hidden = tab.dataset.form !== 'login-form';
    $('register-form').hidden = tab.dataset.form !== 'register-form';
    showMessage($('auth-message'), '');
  });
});

$('register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    await api('POST', '/users', Object.fromEntries(new FormData(form)));
    form.reset();
    showMessage($('auth-message'), 'Account created. You can log in now.', true);
    document.querySelector('[data-form="login-form"]').click();
  } catch (error) {
    showMessage($('auth-message'), error.message);
  }
});

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('POST', '/login', Object.fromEntries(new FormData(event.target)));
    event.target.reset();
    showApp(data.username);
  } catch (error) {
    showMessage($('auth-message'), error.message);
  }
});

$('logout-btn').addEventListener('click', async () => {
  try {
    await api('DELETE', '/login');
  } finally {
    showAuth();
  }
});

/* ---------- Rendering ---------- */

/** Builds a post card for one item returned by the web service. */
function buildPost(post) {
  const card = el('article', 'card post');

  const head = el('div', 'post-head');
  const avatar = el('img', 'avatar');
  avatar.src = post.avatar || DEFAULT_AVATAR;
  avatar.alt = '';
  head.append(avatar, el('strong', '', post.username));
  card.append(head);

  if (post.image) {
    const img = el('img', 'post-img');
    img.src = post.image;
    img.alt = `Photo by ${post.username}`;
    card.append(img);
  }
  card.append(el('p', 'post-text', post.text));

    // Existing replies
  const replies = el('div', 'replies');
  post.replies.forEach((reply) => replies.append(buildReply(reply)));
  card.append(replies);

  // Reply form
  const form = el('form', 'reply-form');
  const input = el('input');
  input.placeholder = 'Write a reply';
  input.required = true;
  const button = el('button', 'btn', 'Reply');
  button.type = 'submit';
  form.append(input, button);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('POST', `/contents/${post._id}/replies`, { text: input.value });
      replies.append(buildReply({ username: currentUser, text: input.value }));
      input.value = '';
    } catch (error) {
      showMessage($('status'), error.message);
    }
  });
  card.append(form);

  return card;
}

/** Builds one reply line: bold username followed by the reply text. */
function buildReply(reply) {
  const line = el('p', 'reply');
  line.append(el('strong', '', reply.username + ' '), reply.text);
  return line;
}

/** Displays a list of posts, or a prompt when there are none. */
function renderPosts(posts, emptyText) {
  const box = $('results');
  box.replaceChildren();
  if (posts.length === 0) box.append(el('p', 'empty', emptyText));
  posts.forEach((post) => box.append(buildPost(post)));
}

/** Displays user search results, each with a follow / unfollow button. */
function renderUsers(users) {
  const box = $('results');
  box.replaceChildren();
  if (users.length === 0) box.append(el('p', 'empty', 'No people found.'));

  users.forEach((user) => {
    const row = el('div', 'card user-row');
    const button = el('button', 'btn', 'Follow');
    let following = Boolean(user.following);

    const refresh = () => {
      button.textContent = following ? 'Following' : 'Follow';
      button.classList.toggle('following', following);
    };
    refresh();

    button.addEventListener('click', async () => {
      try {
        const name = encodeURIComponent(user.username);
        await api(following ? 'DELETE' : 'POST', `/follow/${name}`);
        following = !following;
        refresh();
        showMessage($('status'), following ? `You are now following ${user.username}.` : `You unfollowed ${user.username}.`, true);
      } catch (error) {
        showMessage($('status'), error.message);
      }
    });

    row.append(el('div', 'avatar', user.username.charAt(0)), el('span', 'name', user.username), button);
    box.append(row);
  });
}

/* ---------- Feed, posting and search ---------- */

async function loadFeed() {
  $('profile').hidden = true;
  $('results-title').textContent = 'Your feed';
  showMessage($('status'), '');
  try {
    renderPosts(toList(await api('GET', '/contents')), 'Nothing here yet. Search for people to follow and their photos will appear.');
  } catch (error) {
    showMessage($('status'), error.message);
  }
}

async function loadProfile(username) {
  $('results-title').textContent = 'Posts';
  showMessage($('status'), '');
  try {
    const profile = await api('GET', `/users/${encodeURIComponent(username)}`);
    $('profile-name').textContent = profile.username;
    $('profile-followers').textContent = profile.followers;
    $('profile-following').textContent = profile.following;
    $('profile-photo').src = profile.profilePhoto || DEFAULT_AVATAR;

    // Only the owner can click the photo to change it
    $('photo-label').classList.toggle('editable', profile.isOwner);
    $('profile-photo-input').disabled = !profile.isOwner;

    $('profile').hidden = false;
    renderPosts(profile.posts, 'No posts to show.');
  } catch (error) {
    showMessage($('status'), error.message);
  }
}

$('profile-btn').addEventListener('click', () => loadProfile(currentUser));

$('nav-feed').addEventListener('click', loadFeed);

$('photo-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  $('preview').hidden = !file;
  if (file) $('preview').src = URL.createObjectURL(file);
});

$('post-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('POST', '/contents', new FormData(event.target));
    event.target.reset();
    $('preview').hidden = true;
    showMessage($('status'), 'Posted.', true);
  } catch (error) {
    showMessage($('status'), error.message);
  }
});

$('search-form').addEventListener('submit', async (event) => {
  $('profile').hidden = true;
  event.preventDefault();
  const type = $('search-type').value;
  const query = encodeURIComponent($('search-input').value.trim());
  $('results-title').textContent = type === 'users' ? 'People' : 'Photos';
  showMessage($('status'), '');
  try {
    const list = toList(await api('GET', `/${type}/search?q=${query}`));
    if (type === 'users') renderUsers(list);
    else renderPosts(list, 'No photos found.');
  } catch (error) {
    showMessage($('status'), error.message);
  }
});

$('profile-photo-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const data = new FormData();
  data.append('image', file);   // 'image' must match upload.single('image') on the server

  try {
    await api('PUT', '/users/photo', data);   // sends the file to the server
    await loadProfile(currentUser);           // redraws the header and all your posts
    showMessage($('status'), 'Profile photo updated.', true);
  } catch (error) {
    showMessage($('status'), error.message);
  }
  event.target.value = '';   // lets you choose the same file again later
});

/* ---------- Start-up: check for an existing session ---------- */

(async function init() {
  try {
    const data = await api('GET', '/login');
    if (data.loggedIn) showApp(data.username);
    else showAuth();
  } catch (error) {
    showAuth();
  }
})();
