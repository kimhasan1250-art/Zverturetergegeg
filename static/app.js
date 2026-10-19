(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { user: null, followingFeed: false, posts: [], suggestions: [], toastTimer: null, observer: null };
  const icon = {
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 8.7c0 4.3-8.4 9.6-8.4 9.6S3.6 13 3.6 8.7A4.4 4.4 0 0 1 12 6.4a4.4 4.4 0 0 1 8.4 2.3Z"/></svg>',
    repost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
    comments: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.2-.7L4 20l1.7-4.3A7.4 7.4 0 0 1 5 12.5 7.5 7.5 0 1 1 20 11.5Z"/><path d="M9 12h.01M12.5 12h.01M16 12h.01"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>'
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      credentials: 'same-origin'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие.');
    return data;
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2700);
  }

  function compact(number) {
    return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(number) || 0);
  }

  function initials(name) {
    const clean = String(name || 'Z').trim();
    return Array.from(clean)[0]?.toUpperCase() || 'Z';
  }

  function ago(timestamp) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(timestamp)));
    if (seconds < 60) return 'только что';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
    return `${Math.floor(seconds / 86400)} дн назад`;
  }

  function updateDate() {
    const date = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    const line = $('.feed-heading .eyebrow');
    if (line) line.textContent = date.toLocaleUpperCase('ru-RU');
  }

  function applyTheme(theme) {
    document.body.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
    ['#themeToggle', '#themeToggleMobile'].forEach(selector => {
      const button = $(selector);
      if (button) button.setAttribute('aria-label', label);
    });
  }

  function updateUser(user) {
    state.user = user;
    if (!user) return;
    const name = user.display_name || user.username;
    $('#sidebarName').textContent = name;
    $('#sidebarHandle').textContent = `@${user.username}`;
    $('#sidebarAvatar').textContent = initials(name);
    $('#railName').textContent = name;
    $('#railHandle').textContent = `@${user.username}`;
    $('#railAvatar').textContent = initials(name);
    $('#railBio').textContent = user.bio || 'Пока здесь только ты и твои истории.';
    $('#statPosts').textContent = compact(user.posts_count);
    $('#statLikes').textContent = compact(user.likes_received);
    $('#statFollowing').textContent = compact(user.following_count);
    $('#statFollowers').textContent = compact(user.followers_count);
    applyTheme(user.theme);
  }

  function showApp() {
    $('#loginScreen').hidden = true;
    $('#appShell').hidden = false;
    updateDate();
  }

  function showLogin() {
    $('#appShell').hidden = true;
    $('#loginScreen').hidden = false;
    setAuthMode('login');
    $('#loginPassword').value = '';
    $('#loginError').textContent = '';
    state.user = null;
    closeModal();
  }

  function setAuthMode(mode) {
    const registering = mode === 'register';
    $('#loginView').hidden = registering;
    $('#registerView').hidden = !registering;
    $('#loginScreen').setAttribute('aria-labelledby', registering ? 'registerTitle' : 'loginTitle');
    $('#loginError').textContent = '';
    $('#registerError').textContent = '';
    if (!registering) {
      $('#registerForm').reset();
      resetGeneratedPasswordState();
      $('#registerError').textContent = '';
      updatePasswordRules();
    }
  }

  function resetGeneratedPasswordState() {
    const input = $('#registerPassword');
    const toggle = $('#registerPasswordToggle');
    const note = $('#passwordGeneratedNote');
    if (input) input.type = 'password';
    if (toggle) toggle.setAttribute('aria-label', 'Показать пароль');
    if (note) note.hidden = true;
  }

  function updatePasswordRules() {
    const input = $('#registerPassword');
    if (!input) return;
    const password = input.value;
    const rules = {
      length: password.length >= 8 && password.length <= 128,
      uppercase: /[A-Z]/.test(password),
      lowercase: /[a-z]/.test(password),
      number: /[0-9]/.test(password),
      symbol: /[^\p{L}\p{N}\s]/u.test(password)
    };
    $$('[data-rule]').forEach(item => item.classList.toggle('valid', Boolean(rules[item.dataset.rule])));
  }

  function secureRandomIndex(max) {
    if (!window.crypto?.getRandomValues) throw new Error('В этом браузере недоступна безопасная генерация паролей. Открой сайт в современном браузере.');
    const range = 0x100000000;
    const limit = Math.floor(range / max) * max;
    const value = new Uint32Array(1);
    do { window.crypto.getRandomValues(value); } while (value[0] >= limit);
    return value[0] % max;
  }

  function generateSecurePassword() {
    const groups = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!@#$%^&*-_+=?'];
    const chars = groups.map(group => group[secureRandomIndex(group.length)]);
    const allChars = groups.join('');
    while (chars.length < 16) chars.push(allChars[secureRandomIndex(allChars.length)]);
    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = secureRandomIndex(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }

  function setNavActive(name) {
    $$('[data-nav]').forEach(button => {
      const active = button.dataset.nav === name;
      button.classList.toggle('active', active);
    });
  }

  async function refreshMe() {
    const data = await api('/api/me');
    updateUser(data.user);
    return data.user;
  }

  async function loadFeed(following = state.followingFeed) {
    state.followingFeed = following;
    const list = $('#feedList');
    const loading = $('#feedLoading');
    loading.hidden = false;
    list.innerHTML = '';
    $('#forYouTab').classList.toggle('selected', !following);
    $('#forYouTab').setAttribute('aria-selected', String(!following));
    $('#followingTab').classList.toggle('selected', following);
    $('#followingTab').setAttribute('aria-selected', String(following));
    $('#forYouTab .tab-line')?.remove();
    $('#followingTab .tab-line')?.remove();
    const selected = following ? $('#followingTab') : $('#forYouTab');
    selected.insertAdjacentHTML('beforeend', '<span class="tab-line"></span>');
    try {
      const data = await api(`/api/feed${following ? '?following=1' : ''}`);
      state.posts = data.posts;
      renderFeed(data.posts);
    } catch (error) {
      list.innerHTML = `<div class="empty-state"><div class="empty-mark">!</div><h2>Лента не загрузилась</h2><p>${escapeHtml(error.message)}</p></div>`;
    } finally {
      loading.hidden = true;
    }
  }

  function postMarkup(post) {
    const name = post.display_name || post.username;
    const follow = post.is_own ? '' : `<button class="follow-button${post.is_following ? ' following' : ''}" data-follow="${post.author_id}" type="button" aria-pressed="${Boolean(post.is_following)}">${post.is_following ? 'Вы подписаны' : 'Подписаться'}</button>`;
    const isMeme = Boolean(post.meme_text);
    return `<article class="post-card" data-post="${escapeHtml(post.id)}">
      <header class="post-top">
        <div class="avatar post-avatar">${escapeHtml(initials(name))}</div>
        <div class="author-copy"><strong>${escapeHtml(name)}</strong><span>@${escapeHtml(post.username)} <i aria-hidden="true">·</i> ${escapeHtml(ago(post.created_at))}</span></div>
        ${follow}<button class="post-menu" type="button" data-post-menu aria-label="Ещё" title="Ещё">···</button>
      </header>
      <div class="video-stage">
        <video src="${escapeHtml(post.video_url)}" muted loop playsinline preload="metadata" controls aria-label="Видео от ${escapeHtml(name)}"></video>
        <span class="video-vignette"></span><span class="video-label${isMeme ? ' meme-badge' : ''}"><i></i> ${isMeme ? 'МЕМ' : 'ZV SHORTS'}</span>
        ${isMeme ? `<div class="meme-overlay"><p>${escapeHtml(post.meme_text)}</p></div>` : ''}
        <div class="action-rail">
          <button class="action-button${post.liked ? ' liked' : ''}" data-action="like" type="button" aria-label="${post.liked ? 'Убрать лайк' : 'Поставить лайк'}" aria-pressed="${Boolean(post.liked)}"><span class="action-icon">${icon.heart}</span><span data-count="likes">${compact(post.likes_count)}</span></button>
          <button class="action-button${post.reposted ? ' reposted' : ''}" data-action="repost" type="button" aria-label="${post.reposted ? 'Отменить репост' : 'Репост'}" aria-pressed="${Boolean(post.reposted)}"><span class="action-icon">${icon.repost}</span><span data-count="reposts">${compact(post.reposts_count)}</span></button>
          <button class="action-button" data-action="comment" type="button" aria-label="Комментарии"><span class="action-icon">${icon.comments}</span><span>Ответить</span></button>
        </div>
      </div>
      <div class="post-content"><p class="post-caption"><strong>${escapeHtml(name)}</strong><span class="handle">@${escapeHtml(post.username)}</span>${escapeHtml(post.caption)}</p><div class="post-meta"><span>Момент из ленты</span><span><i></i> ${escapeHtml(ago(post.created_at))}</span></div></div>
    </article>`;
  }

  function renderFeed(posts) {
    const list = $('#feedList');
    if (!posts.length) {
      list.innerHTML = state.followingFeed
        ? '<div class="empty-state"><div class="empty-mark">↗</div><h2>Твоя лента только начинается</h2><p>Подпишись на людей справа — их новые видео появятся здесь.</p></div>'
        : '<div class="empty-state"><div class="empty-mark">◌</div><h2>Пока тихо</h2><p>Загляни чуть позже — здесь появятся новые короткие истории.</p></div>';
      return;
    }
    list.innerHTML = posts.map(postMarkup).join('');
    setupVideoPlayback();
  }

  function setupVideoPlayback() {
    state.observer?.disconnect();
    state.observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const video = entry.target;
        if (entry.isIntersecting && entry.intersectionRatio >= .6) {
          const play = video.play();
          if (play && typeof play.catch === 'function') play.catch(() => {});
        } else video.pause();
      });
    }, { threshold: [.1, .6] });
    $$('#feedList video').forEach(video => state.observer.observe(video));
  }

  async function loadSuggestions() {
    try {
      const data = await api('/api/suggestions');
      state.suggestions = data.users;
      renderSuggestions(data.users);
    } catch (_) {
      $('#suggestionsList').innerHTML = '<p class="field-hint">Не удалось загрузить рекомендации.</p>';
    }
  }

  function renderSuggestions(users) {
    $('#suggestionCount').textContent = String(users.length).padStart(2, '0');
    $('#suggestionsList').innerHTML = users.map(user => `<div class="suggestion" data-suggestion="${user.id}">
      <div class="avatar">${escapeHtml(initials(user.display_name))}</div>
      <div class="suggestion-copy"><strong>${escapeHtml(user.display_name)}</strong><span>@${escapeHtml(user.username)}</span></div>
      <button class="${user.is_following ? 'following' : ''}" data-follow="${user.id}" type="button" aria-pressed="${Boolean(user.is_following)}">${user.is_following ? 'Подписан' : 'Следить'}</button>
    </div>`).join('');
  }

  function openModal(markup, afterOpen) {
    const root = $('#modalRoot');
    root.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true">${markup}</section>`;
    root.hidden = false;
    root.onclick = event => { if (event.target === root) closeModal(); };
    $('.modal-close', root)?.addEventListener('click', closeModal);
    afterOpen?.(root);
    $('.modal-close', root)?.focus();
  }

  function closeModal() {
    const root = $('#modalRoot');
    root.hidden = true;
    root.innerHTML = '';
    root.onclick = null;
  }

  function openProfileModal() {
    const user = state.user;
    if (!user) return;
    openModal(`<div class="modal-head"><div><p class="eyebrow">ТВОЯ СТРАНИЦА</p><h2>Настроить профиль</h2><p>Имя, логин и описание видны другим людям.</p></div><button class="icon-button modal-close" type="button" aria-label="Закрыть">${icon.close}</button></div>
      <div class="profile-modal-summary">
        <div class="profile-stat-card"><strong>${compact(user.posts_count)}</strong><span>видео</span></div><div class="profile-stat-card"><strong>${compact(user.likes_received)}</strong><span>лайков</span></div><div class="profile-stat-card"><strong>${compact(user.following_count)}</strong><span>подписок</span></div><div class="profile-stat-card"><strong>${compact(user.followers_count)}</strong><span>подписчиков</span></div>
      </div>
      <form class="modal-form" id="profileForm"><label for="profileName">Имя профиля</label><input class="field-input" id="profileName" name="display_name" maxlength="40" required value="${escapeHtml(user.display_name)}">
      <label for="profileUsername">Логин</label><input class="field-input" id="profileUsername" name="username" maxlength="24" required value="${escapeHtml(user.username)}"><p class="field-hint">Латинские буквы, цифры, точка и подчёркивание.</p>
      <label for="profileBio">О себе</label><textarea class="field-textarea" id="profileBio" name="bio" maxlength="120" placeholder="Добавь пару слов о себе">${escapeHtml(user.bio)}</textarea><p class="form-error" id="profileError" role="alert"></p>
      <div class="modal-actions"><button class="button button-outline" type="button" data-modal-cancel>Отмена</button><button class="button button-dark" type="submit">Сохранить ↗</button></div></form>`, root => {
      $('[data-modal-cancel]', root).addEventListener('click', closeModal);
      $('#profileForm', root).addEventListener('submit', async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const error = $('#profileError', root);
        error.textContent = '';
        try {
          const data = await api('/api/profile', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(form.entries())) });
          updateUser(data.user);
          closeModal();
          showToast('Профиль обновлён');
          loadFeed();
          loadSuggestions();
        } catch (err) { error.textContent = err.message; }
      });
    });
  }

  function openSettingsModal() {
    const dark = state.user?.theme === 'dark';
    openModal(`<div class="modal-head"><div><p class="eyebrow">НАСТРОЙКИ</p><h2>Твоё пространство</h2><p>Настрой Zverturet так, как тебе удобно.</p></div><button class="icon-button modal-close" type="button" aria-label="Закрыть">${icon.close}</button></div>
      <div class="settings-row"><div><strong>Внешний вид</strong><span>Светлая или тёмная тема</span></div><button class="theme-switch" id="themeSwitch" type="button" role="switch" aria-checked="${dark}" aria-label="Переключить тему"></button></div>
      <div class="settings-row"><div><strong>Профиль</strong><span>Измени имя, логин и описание</span></div><button class="button button-outline" id="settingsProfile" type="button" style="min-height:32px;padding:0 10px;font-size:9px">Открыть ↗</button></div>
      <p class="settings-note">Тема и данные профиля сохраняются для этого демо-аккаунта. Видео в примере загружаются с открытых демонстрационных источников.</p>`, root => {
      $('#themeSwitch', root).addEventListener('click', async event => {
        const next = state.user.theme === 'dark' ? 'light' : 'dark';
        try {
          const data = await api('/api/preferences', { method: 'PATCH', body: JSON.stringify({ theme: next }) });
          state.user.theme = data.theme;
          applyTheme(data.theme);
          event.currentTarget.setAttribute('aria-checked', String(data.theme === 'dark'));
        } catch (error) { showToast(error.message); }
      });
      $('#settingsProfile', root).addEventListener('click', openProfileModal);
    });
  }

  async function toggleFollow(button) {
    const targetId = button.dataset.follow;
    if (!targetId) return;
    button.disabled = true;
    try {
      const data = await api(`/api/users/${targetId}/follow`, { method: 'POST', body: '{}' });
      await refreshMe();
      await loadSuggestions();
      await loadFeed();
      showToast(data.following ? 'Ты подписался на автора' : 'Подписка отменена');
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  }

  async function togglePostAction(button) {
    const card = button.closest('[data-post]');
    const action = button.dataset.action;
    if (!card || !['like', 'repost'].includes(action)) return;
    button.disabled = true;
    try {
      const data = await api(`/api/posts/${encodeURIComponent(card.dataset.post)}/${action}`, { method: 'POST', body: '{}' });
      button.setAttribute('aria-pressed', String(data.active));
      button.classList.toggle(action === 'like' ? 'liked' : 'reposted', data.active);
      button.setAttribute('aria-label', action === 'like' ? (data.active ? 'Убрать лайк' : 'Поставить лайк') : (data.active ? 'Отменить репост' : 'Репост'));
      const count = $('[data-count]', button);
      count.textContent = compact(data.count);
      const post = state.posts.find(item => item.id === card.dataset.post);
      if (post) {
        if (action === 'like') { post.liked = data.active; post.likes_count = data.count; }
        else { post.reposted = data.active; post.reposts_count = data.count; }
      }
      if (action === 'repost') showToast(data.active ? 'Добавлено в твои репосты' : 'Репост отменён');
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  }

  function setFeedMode(following) {
    setNavActive(following ? 'following' : 'feed');
    loadFeed(following);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function bindEvents() {
    $('#fillDemo').addEventListener('click', () => {
      $('#loginUsername').value = 'zverturet';
      $('#loginPassword').value = '12345678';
      $('#loginError').textContent = '';
      $('#loginPassword').focus();
    });
    $('#passwordToggle').addEventListener('click', event => {
      const input = $('#loginPassword');
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      event.currentTarget.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
    });
    $('#showRegister').addEventListener('click', () => {
      setAuthMode('register');
      $('#registerName').focus();
    });
    $('#showLogin').addEventListener('click', () => {
      setAuthMode('login');
      $('#loginUsername').focus();
    });
    $('#generatePassword').addEventListener('click', () => {
      const error = $('#registerError');
      try {
        const password = generateSecurePassword();
        $('#registerPassword').value = password;
        $('#registerPassword').type = 'text';
        $('#registerConfirm').value = password;
        $('#registerPasswordToggle').setAttribute('aria-label', 'Скрыть пароль');
        $('#passwordGeneratedNote').hidden = false;
        error.textContent = '';
        updatePasswordRules();
      } catch (err) {
        error.textContent = err.message;
      }
    });
    $('#registerPassword').addEventListener('input', () => {
      $('#passwordGeneratedNote').hidden = true;
      updatePasswordRules();
    });
    $('#registerPasswordToggle').addEventListener('click', event => {
      const input = $('#registerPassword');
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      event.currentTarget.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
    });
    $('#loginForm').addEventListener('submit', async event => {
      event.preventDefault();
      const error = $('#loginError');
      const submit = $('button[type="submit"]', event.currentTarget);
      error.textContent = '';
      submit.disabled = true;
      try {
        const form = new FormData(event.currentTarget);
        const data = await api('/api/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
        updateUser(data.user);
        showApp();
        await Promise.all([loadFeed(false), loadSuggestions()]);
      } catch (err) { error.textContent = err.message; }
      finally { submit.disabled = false; }
    });
    $('#registerForm').addEventListener('submit', async event => {
      event.preventDefault();
      const error = $('#registerError');
      const submit = $('button[type="submit"]', event.currentTarget);
      const values = Object.fromEntries(new FormData(event.currentTarget).entries());
      error.textContent = '';
      if (values.password !== values.confirm_password) {
        error.textContent = 'Пароли не совпадают.';
        $('#registerConfirm').focus();
        return;
      }
      submit.disabled = true;
      try {
        const data = await api('/api/register', {
          method: 'POST',
          body: JSON.stringify({ display_name: values.display_name, username: values.username, password: values.password })
        });
        event.currentTarget.reset();
        resetGeneratedPasswordState();
        updatePasswordRules();
        updateUser(data.user);
        showApp();
        await Promise.all([loadFeed(false), loadSuggestions()]);
        showToast('Аккаунт создан — добро пожаловать!');
      } catch (err) { error.textContent = err.message; }
      finally { submit.disabled = false; }
    });
    $('#logoutButton').addEventListener('click', async () => {
      try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch (_) {}
      showLogin();
    });
    $('#forYouTab').addEventListener('click', () => setFeedMode(false));
    $('#followingTab').addEventListener('click', () => setFeedMode(true));
    $('#themeToggle').addEventListener('click', toggleTheme);
    $('#themeToggleMobile').addEventListener('click', toggleTheme);
    document.addEventListener('click', event => {
      const nav = event.target.closest('[data-nav]');
      if (nav) {
        const destination = nav.dataset.nav;
        setNavActive(destination);
        if (destination === 'following') setFeedMode(true);
        if (destination === 'feed') setFeedMode(false);
        if (destination === 'profile') openProfileModal();
        if (destination === 'settings') openSettingsModal();
      }
      const follow = event.target.closest('[data-follow]');
      if (follow) toggleFollow(follow);
      const action = event.target.closest('[data-action]');
      if (action?.dataset.action === 'comment') showToast('Комментарии появятся в следующем обновлении');
      else if (action) togglePostAction(action);
      const menu = event.target.closest('[data-post-menu]');
      if (menu) showToast('Ты просматриваешь короткое видео в Zverturet');
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#modalRoot').hidden) closeModal(); });
  }

  async function toggleTheme() {
    if (!state.user) return;
    const next = state.user.theme === 'dark' ? 'light' : 'dark';
    try {
      const data = await api('/api/preferences', { method: 'PATCH', body: JSON.stringify({ theme: next }) });
      state.user.theme = data.theme;
      applyTheme(data.theme);
      const switchButton = $('#themeSwitch');
      if (switchButton) switchButton.setAttribute('aria-checked', String(data.theme === 'dark'));
    } catch (error) { showToast(error.message); }
  }

  async function init() {
    bindEvents();
    updateDate();
    try {
      const data = await api('/api/me');
      updateUser(data.user);
      showApp();
      await Promise.all([loadFeed(false), loadSuggestions()]);
    } catch (_) {
      applyTheme('light');
      $('#loginScreen').hidden = false;
      $('#appShell').hidden = true;
    }
  }

  init();
})();
