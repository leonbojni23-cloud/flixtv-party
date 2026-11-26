'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const inviteCode = (params.get('code') || '').trim().toUpperCase();
  const sessionKey = 'flixtv-party-session';
  const userKey = 'flixtv-party-user';
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); } catch {}
  if (!session || session.roomId !== roomId) session = null;

  let socket = null;
  let roomState = null;
  let members = [];
  let isHost = false;
  let userId = '';
  let applyingRemote = false;
  let toastTimer = null;
  let chatCount = 0;
  const video = $('party-video');
  const playerFrame = $('player-frame');

  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('visible'), 2800);
  }
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h ? [h,m,r].map(v => String(v).padStart(2,'0')).join(':') : [m,r].map(v => String(v).padStart(2,'0')).join(':');
  }
  function initials(name) { return String(name || '?').trim().slice(0,1).toUpperCase(); }
  function escapeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function setConnection(label, connected) {
    $('connection-label').textContent = label;
    document.querySelector('.live-dot').style.background = connected ? '#42d993' : '#e85b63';
  }
  function renderMembers() {
    $('member-count').textContent = members.length + (members.length === 1 ? ' person' : ' people');
    $('people-count').textContent = members.length;
    $('watching-label').textContent = members.length ? members.map(m => m.username).slice(0,3).join(', ') + (members.length > 3 ? ' +' + (members.length - 3) : '') + ' po shikojnë' : 'Duke pritur pjesëmarrësit…';
    $('avatar-stack').innerHTML = members.slice(0,5).map(m => '<span class="avatar" title="' + escapeText(m.username) + '">' + escapeText(initials(m.username)) + '</span>').join('');
    $('people-list').innerHTML = members.map(m => '<div class="person"><span class="avatar">' + escapeText(initials(m.username)) + '</span><div><div class="person-name">' + escapeText(m.username) + '</div><div class="person-role">' + (m.isHost ? 'Host · kontrollon filmin' : 'Pjesëmarrës') + '</div></div></div>').join('') || '<div class="chat-empty">Ende nuk ka pjesëmarrës.</div>';
  }
  function appendChat(item) {
    const empty = $('chat-messages').querySelector('.chat-empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'chat-message';
    const time = new Date(item.createdAt || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    row.innerHTML = '<span class="chat-avatar">' + escapeText(initials(item.username)) + '</span><div class="chat-copy"><div class="chat-meta"><span class="chat-name">' + escapeText(item.username) + '</span>' + (item.isHost ? '<span class="host-tag">HOST</span>' : '') + '<span class="chat-time">' + time + '</span></div><div class="chat-text">' + escapeText(item.message) + '</div></div>';
    $('chat-messages').appendChild(row);
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
    chatCount++;
    $('chat-count').textContent = chatCount;
  }
  function renderRoom(state) {
    roomState = state;
    members = state.members || [];
    const self = members.find(m => m.userId === userId);
    isHost = Boolean(self?.isHost);
    document.querySelectorAll('.host-only').forEach(node => node.classList.toggle('hidden', !isHost));
    $('movie-title').textContent = state.movie?.title || 'Watch Party';
    $('room-name').textContent = state.name || 'FLIXTV Watch Party';
    renderMembers();
    $('chat-messages').innerHTML = '';
    chatCount = 0;
    (state.chat || []).forEach(appendChat);
    if (state.media?.url) loadMedia(state.media.url);
    else showEmptyPlayer();
    if (state.playback) applyPlayback(state.playback);
    $('seek-bar').disabled = !isHost;
  }
  function showEmptyPlayer() {
    $('player-empty').classList.remove('hidden');
    $('empty-description').textContent = isHost ? 'Vendos burimin direkt të videos për ta nisur me të gjithë.' : 'Po presim që host-i të lidhë burimin e filmit.';
    $('player-controls').style.display = 'none';
    $('source-card').classList.toggle('hidden', !isHost);
  }
  function loadMedia(url) {
    if (!url) return;
    let parsed;
    try { parsed = new URL(url); } catch { toast('Linku i videos nuk është i vlefshëm.'); return; }
    if (!['https:', 'http:'].includes(parsed.protocol)) { toast('Burimi duhet të jetë një link HTTP ose HTTPS.'); return; }
    if (video.dataset.source !== url) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.dataset.source = url;
      video.src = url;
      video.load();
    }
    $('player-empty').classList.add('hidden');
    $('player-controls').style.display = 'flex';
    $('source-card').classList.add('hidden');
    $('edit-source').classList.toggle('hidden', !isHost);
    $('sync-label').textContent = 'BURIMI U LIDH';
    $('source-url').value = url;
    const isHls = /\.m3u8(?:$|\?)/i.test(url);
    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      $('sync-label').textContent = 'HLS NUK MBËSHTETET';
      toast('Ky shfletues nuk luan HLS direkt. Në iPhone përdor Safari.');
    }
  }
  function applyPlayback(playback) {
    if (!playback || !video.dataset.source) return;
    applyingRemote = true;
    const target = Number(playback.position) || 0;
    if (Number.isFinite(video.duration) && Math.abs(video.currentTime - target) > 1.4) {
      try { video.currentTime = target; } catch {}
    }
    if (playback.status === 'playing') {
      const promise = video.play();
      if (promise?.catch) promise.catch(() => toast('Prek Play në player për të lejuar nisjen e videos në iPhone.'));
    } else {
      video.pause();
    }
    $('sync-label').textContent = 'SINKRONIZUAR';
    setTimeout(() => { applyingRemote = false; }, 500);
  }
  function sendPlayback(action, position = video.currentTime || 0) {
    if (!isHost || !socket?.connected || applyingRemote) return;
    socket.emit('playback:command', {action, position, duration:Number.isFinite(video.duration) ? video.duration : 0}, ack => {
      if (!ack?.ok) toast('Komanda nuk u sinkronizua.');
    });
  }
  function connect(credentials) {
    return new Promise((resolve, reject) => {
      if (!roomId || roomId.length > 32) return reject(new Error('Adresa e dhomës nuk është e vlefshme.'));
      socket = io({transports:['websocket','polling'],timeout:10000,reconnectionAttempts:5});
      const timeout = setTimeout(() => reject(new Error('Serveri nuk u përgjigj. Rifresko faqen.')), 12000);
      socket.once('connect', () => {
        socket.emit('room:join', {
          roomId, username:credentials.username, inviteCode:credentials.inviteCode || inviteCode,
          hostToken:credentials.hostToken || undefined,
          userId:localStorage.getItem(userKey) || (function(){const id='user-'+Math.random().toString(36).slice(2);localStorage.setItem(userKey,id);return id;})()
        }, ack => {
          clearTimeout(timeout);
          if (!ack?.ok) return reject(new Error(ack?.error === 'INVALID_INVITE_CODE' ? 'Kodi i ftesës nuk është i saktë.' : ack?.error === 'ROOM_NOT_FOUND' ? 'Kjo dhomë nuk ekziston ose ka skaduar.' : ack?.error || 'Nuk u bashkove dot.'));
          userId = ack.userId;
          session = {...credentials,roomId};
          sessionStorage.setItem(sessionKey,JSON.stringify(session));
          renderRoom(ack.room);
          setConnection('ONLINE',true);
          resolve(ack);
        });
      });
      socket.on('connect_error', () => { clearTimeout(timeout); reject(new Error('Nuk u lidhëm me serverin. Kontrollo internetin dhe provo përsëri.')); });
      socket.on('disconnect', () => setConnection('U SHKËPUT',false));
      socket.on('room:state', state => { if (!roomState) renderRoom(state); });
      socket.on('presence:update', data => { members = data.members || []; renderMembers(); });
      socket.on('presence:joined', data => { toast(data.username + ' u bashkua.'); });
      socket.on('presence:left', data => { toast(data.username + ' u largua.'); });
      socket.on('playback:state', state => applyPlayback(state));
      socket.on('media:state', data => { if (data?.media?.url) { loadMedia(data.media.url); toast('Host-i lidhi filmin.'); } });
      socket.on('chat:new', appendChat);
      socket.on('reaction:new', data => showReaction(data.emoji));
      socket.on('room:host-changed', data => { toast(data.username + ' është host i ri.'); });
      socket.on('room:closed', () => { toast('Dhoma u mbyll ose skadoi.'); setTimeout(() => location.href='/',1800); });
      socket.on('room:replaced', () => { toast('Kjo llogari u lidh nga një pajisje tjetër.'); });
    });
  }
  function showReaction(emoji) {
    const node = document.createElement('span');
    node.className = 'reaction-float';
    node.textContent = emoji;
    node.style.setProperty('--drift',(Math.random()*60-30)+'px');
    $('reaction-floats').appendChild(node);
    setTimeout(() => node.remove(),1900);
  }
  function showGate() {
    $('join-gate').classList.remove('hidden');
    $('gate-form').addEventListener('submit', async event => {
      event.preventDefault();
      const username = $('gate-username').value.trim();
      if (!username) return;
      const button = $('gate-form').querySelector('button');
      button.disabled = true;
      button.textContent = 'Duke u bashkuar…';
      $('gate-error').textContent = '';
      try {
        if (!inviteCode) throw new Error('Mungon kodi i ftesës. Hape linkun që të dërguan.');
        await connect({username,inviteCode});
        $('join-gate').classList.add('hidden');
      } catch (error) {
        $('gate-error').textContent = error.message;
        button.disabled = false;
        button.textContent = 'Bashkohu në dhomë ↗';
      }
    });
  }

  $('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    const message = $('chat-input').value.trim();
    if (!message || !socket?.connected) return;
    socket.emit('chat:send',{message},ack => { if (ack?.ok) $('chat-input').value=''; else toast('Mesazhi nuk u dërgua.'); });
  });
  document.querySelectorAll('.reaction-bar button').forEach(button => button.addEventListener('click',() => {
    if (!socket?.connected) return;
    socket.emit('reaction:send',{emoji:button.dataset.emoji},ack => { if (ack?.ok) showReaction(button.dataset.emoji); });
  }));
  $('save-source').addEventListener('click',() => {
    const url = $('source-url').value.trim();
    if (!isHost) return toast('Vetëm host-i mund të vendosë burimin.');
    if (!/^https?:\/\//i.test(url)) return $('source-note').textContent='Vendos një link të plotë që fillon me https://';
    $('save-source').disabled=true;
    socket.emit('media:set',{url},ack => {
      $('save-source').disabled=false;
      if (!ack?.ok) return toast(ack?.error || 'Burimi nuk u ruajt.');
      loadMedia(url);
      toast('Burimi u nda me të gjithë pjesëmarrësit.');
    });
  });
  $('add-source-empty').addEventListener('click',() => $('source-card').scrollIntoView({behavior:'smooth',block:'center'}));
  $('edit-source').addEventListener('click',() => { $('source-card').classList.toggle('hidden'); $('source-url').focus(); });
  $('play-toggle').addEventListener('click',() => {
    if (!isHost) return toast('Vetëm host-i kontrollon Play dhe Pause.');
    if (!video.dataset.source) return toast('Host-i duhet të vendosë burimin e videos.');
    if (video.paused) video.play().catch(() => toast('Prek përsëri Play për të nisur videon.'));
    else video.pause();
  });
  video.addEventListener('play',() => { $('play-toggle').textContent='Ⅱ'; if (!applyingRemote) sendPlayback('play'); });
  video.addEventListener('pause',() => { $('play-toggle').textContent='▶'; if (!applyingRemote && !video.ended) sendPlayback('pause'); });
  video.addEventListener('seeked',() => { if (!applyingRemote) sendPlayback('seek'); });
  video.addEventListener('timeupdate',() => {
    $('current-time').textContent=formatTime(video.currentTime);
    $('duration').textContent=formatTime(video.duration);
    if (Number.isFinite(video.duration) && video.duration > 0 && !document.activeElement.isSameNode($('seek-bar'))) $('seek-bar').value=String(Math.round(video.currentTime/video.duration*1000));
  });
  $('seek-bar').addEventListener('input',() => {
    if (!isHost || !Number.isFinite(video.duration)) return;
    $('current-time').textContent=formatTime(Number($('seek-bar').value)/1000*video.duration);
  });
  $('seek-bar').addEventListener('change',() => {
    if (!isHost || !Number.isFinite(video.duration)) return;
    video.currentTime=Number($('seek-bar').value)/1000*video.duration;
    sendPlayback('seek');
  });
  $('fullscreen-button').addEventListener('click',async() => {
    try {
      if (video.webkitEnterFullscreen && /iPhone|iPod/i.test(navigator.userAgent)) video.webkitEnterFullscreen();
      else if (!document.fullscreenElement) {
        await playerFrame.requestFullscreen?.();
        try { await screen.orientation?.lock?.('landscape'); } catch {}
      } else await document.exitFullscreen();
    } catch { toast('Fullscreen nuk mbështetet në këtë shfletues.'); }
  });
  document.addEventListener('fullscreenchange',() => { if (!document.fullscreenElement) try { screen.orientation?.unlock?.(); } catch {} });
  function openPanel(panel) {
    document.querySelectorAll('.side-tab').forEach(b => b.classList.toggle('active',b.dataset.panel===panel));
    document.querySelectorAll('.side-content').forEach(p => p.classList.toggle('active',p.id===panel));
    if (window.matchMedia('(max-width: 680px)').matches) {
      $('side-panel').classList.add('mobile-open');
      $('sheet-backdrop').classList.add('visible');
      document.querySelectorAll('.mobile-nav-button').forEach(b => b.classList.toggle('active',b.dataset.mobilePanel===panel));
    }
  }
  document.querySelectorAll('.side-tab').forEach(b => b.addEventListener('click',() => openPanel(b.dataset.panel)));
  document.querySelectorAll('.mobile-nav-button[data-mobile-panel]').forEach(b => b.addEventListener('click',() => {
    if ($('side-panel').classList.contains('mobile-open') && b.classList.contains('active')) {
      $('side-panel').classList.remove('mobile-open');$('sheet-backdrop').classList.remove('visible');
    } else openPanel(b.dataset.mobilePanel);
  }));
  $('sheet-backdrop').addEventListener('click',() => {$('side-panel').classList.remove('mobile-open');$('sheet-backdrop').classList.remove('visible');});
  async function copyInvite() {
    const url=location.origin+'/party/'+encodeURIComponent(roomId)+(inviteCode?'?code='+encodeURIComponent(inviteCode):'');
    try { await navigator.clipboard.writeText(url);toast('Linku i ftesës u kopjua.'); }
    catch { window.prompt('Kopjo linkun e ftesës:',url); }
  }
  $('invite-button').addEventListener('click',copyInvite);
  $('mobile-invite').addEventListener('click',copyInvite);
  $('leave-room').addEventListener('click',() => {
    if (socket?.connected) socket.emit('room:leave');
    socket?.disconnect();
    sessionStorage.removeItem(sessionKey);
    location.href='/';
  });
  let controlsTimer;
  playerFrame.addEventListener('touchstart',() => {
    playerFrame.classList.add('controls-visible');
    clearTimeout(controlsTimer);
    controlsTimer=setTimeout(() => playerFrame.classList.remove('controls-visible'),3500);
  },{passive:true});
  playerFrame.addEventListener('mousemove',() => {
    playerFrame.classList.add('controls-visible');
    clearTimeout(controlsTimer);
    controlsTimer=setTimeout(() => playerFrame.classList.remove('controls-visible'),2500);
  });

  if (!roomId || roomId === 'party') {
    $('join-gate').classList.remove('hidden');
    $('gate-error').textContent='Linku i dhomës nuk është i vlefshëm.';
  } else if (session?.username) {
    connect(session).catch(error => { sessionStorage.removeItem(sessionKey); $('join-gate').classList.remove('hidden'); $('gate-error').textContent=error.message; });
  } else {
    showGate();
  }
})();