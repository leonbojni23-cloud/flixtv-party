'use strict';
const $ = (id) => document.getElementById(id);
const API = '';
let socket;
let currentRoom = null;
let inviteLink = '';
function showError(id, message) { $(id).textContent = message || ''; }
function connectToRoom({roomId, username, inviteCode, hostToken, isHost}) {
  return new Promise((resolve, reject) => {
    if (socket) socket.disconnect();
    socket = io(API, {transports:['websocket','polling'], reconnectionAttempts:4, timeout:10000});
    const timeout = setTimeout(() => reject(new Error('Lidhja me serverin zgjati shumë. Provo përsëri.')), 12000);
    socket.on('connect', () => {
      socket.emit('room:join', {roomId, username, inviteCode, hostToken, userId: localStorage.getItem('flixtv-party-user') || (function(){const id='user-'+Math.random().toString(36).slice(2);localStorage.setItem('flixtv-party-user',id);return id;})()}, (ack) => {
        clearTimeout(timeout);
        if (!ack?.ok) return reject(new Error(ack?.error || 'Nuk u bashkove dot në dhomë.'));
        resolve(ack);
      });
    });
    socket.on('connect_error', () => { clearTimeout(timeout); reject(new Error('Nuk po lidhemi me serverin. Rifresko faqen dhe provo përsëri.')); });
    socket.on('disconnect', () => { if(currentRoom) $('connection-status').textContent = 'U shkëput'; });
  });
}
$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('error','');
  const button = $('create-button');
  const username = $('username').value.trim();
  const movieTitle = $('movie-title').value.trim();
  if (!username || !movieTitle) return showError('error','Plotëso emrin dhe titullin e filmit.');
  button.disabled = true; button.innerHTML = 'Duke krijuar…';
  try {
    const response = await fetch('/api/rooms', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      username, name:$('room-name').value.trim(), visibility:$('private-room').checked?'private':'public',
      movie:{id:$('movie-id').value.trim(),title:movieTitle,type:$('movie-type').value}
    })});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Krijimi i dhomës dështoi.');
    currentRoom = {...data, username};
    $('result-room-name').textContent = data.room.name;
    $('result-movie').textContent = movieTitle + (data.room.visibility==='private'?' · Private':' · Public');
    $('invite-code').textContent = data.inviteCode || 'DHOMË PUBLIKE';
    inviteLink = location.origin + '/?room=' + encodeURIComponent(data.room.id) + (data.inviteCode?'&code='+encodeURIComponent(data.inviteCode):'');
    $('create-card').classList.add('hidden');
    $('result').classList.remove('hidden');
    $('connection-status').textContent = 'Duke u lidhur…';
    try { await connectToRoom({roomId:data.room.id,username,inviteCode:data.inviteCode,hostToken:data.hostToken,isHost:true}); $('connection-status').textContent='Host · Online'; }
    catch(error) { $('connection-status').textContent='Dhoma u krijua'; showError('error',error.message); }
    $('result').scrollIntoView({behavior:'smooth',block:'start'});
  } catch(error) { showError('error',error.message); }
  finally { button.disabled=false; button.innerHTML='Krijo dhomën <span>↗</span>'; }
});
$('copy-invite').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(inviteLink); $('copy-invite').innerHTML='Linku u kopjua ✓'; }
  catch { prompt('Kopjo linkun e ftesës:',inviteLink); }
});
$('copy-code').addEventListener('click', async () => {
  const code=$('invite-code').textContent;
  try { await navigator.clipboard.writeText(code); $('copy-code').textContent='Kodi u kopjua ✓'; }
  catch { prompt('Kodi i ftesës:',code); }
});
$('new-room').addEventListener('click',()=>{if(socket)socket.disconnect();currentRoom=null;$('result').classList.add('hidden');$('create-card').classList.remove('hidden');$('create-form').reset();$('private-room').checked=true;showError('error','');});
$('join-by-code').addEventListener('click', async () => {
  showError('code-error', '');
  $('code-status').textContent = '';
  const button = $('join-by-code');
  const username = $('code-username').value.trim();
  const code = $('invite-code-input').value.trim().toUpperCase().replace(/\\s+/g, '');
  if (!username) return showError('code-error', 'Shkruaj emrin tënd.');
  if (!code) return showError('code-error', 'Shkruaj kodin e ftesës.');
  button.disabled = true;
  button.innerHTML = 'Duke kërkuar dhomën…';
  try {
    const response = await fetch('/api/rooms/by-code/' + encodeURIComponent(code));
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 404 ? 'Kodi nuk është i saktë ose dhoma ka skaduar.' : 'Nuk u gjet dhoma. Provo përsëri.');
    $('code-status').textContent = 'Dhoma u gjet: ' + data.room.name + ' · ' + data.room.movie.title;
    await connectToRoom({ roomId: data.room.id, username, inviteCode: code });
    $('code-status').textContent = 'U bashkove me sukses në dhomën "' + data.room.name + '". Lidhja është aktive.';
    button.textContent = 'U bashkove ✓';
  } catch (error) {
    showError('code-error', error.message || 'Nuk u arrit bashkimi në dhomë.');
    button.disabled = false;
    button.innerHTML = 'Bashkohu me kod <span>↗</span>';
  }
});
$('invite-code-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('join-by-code').click();
});
const params=new URLSearchParams(location.search);
const roomId=params.get('room');
if(roomId){
  $('create-card').classList.add('hidden');$('join-code-card').classList.add('hidden');$('join-card').classList.remove('hidden');
  $('join-description').textContent='Dhoma: '+roomId+'. Vendos emrin dhe bashkohu.';
  $('join-button').addEventListener('click',async()=>{
    showError('join-error','');const button=$('join-button');const username=$('join-username').value.trim();
    if(!username)return showError('join-error','Shkruaj emrin tënd.');
    button.disabled=true;button.textContent='Duke u bashkuar…';
    try{await connectToRoom({roomId,username,inviteCode:params.get('code')||undefined});$('join-status').textContent='U bashkove me sukses në dhomë. Lidhja është aktive.';button.textContent='U bashkove ✓';}
    catch(error){showError('join-error',error.message);button.disabled=false;button.innerHTML='Bashkohu në dhomë <span>↗</span>';}
  });
}