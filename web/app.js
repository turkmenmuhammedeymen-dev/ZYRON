(()=> {
  'use strict';
  const $ = id => document.getElementById(id);
  const store = { values:'zyron_values_v2', profiles:'zyron_profiles_v2', history:'zyron_history_v2' };
  const defaults = [
    {id:1,key:'coins_demo',value:'12500',type:'INTEGER'},
    {id:2,key:'speed_demo',value:'72.5',type:'DECIMAL'},
    {id:3,key:'player_label',value:'ZYRON Tester',type:'TEXT'},
    {id:4,key:'level_demo',value:'18',type:'INTEGER'}
  ];
  const safeRead = (key, fallback) => {
    try { const raw=localStorage.getItem(key); return raw===null?fallback:JSON.parse(raw); }
    catch(error) { console.warn('ZYRON could not read local storage:',error); return fallback; }
  };
  const typeOf = value => {
    const s=String(value).trim();
    if(s!=='' && Number.isSafeInteger(Number(s))) return 'INTEGER';
    if(s!=='' && Number.isFinite(Number(s))) return 'DECIMAL';
    return 'TEXT';
  };
  const normalizeValues = input => Array.isArray(input) ? input.filter(v =>
    v && typeof v==='object' && typeof v.key==='string' && typeof v.value==='string'
    && v.key.trim() && v.key.length<=60 && v.value.length<=200
  ).map((v,i)=>({id:Number.isSafeInteger(v.id)?v.id:Date.now()+i,key:v.key.trim(),value:v.value,type:typeOf(v.value)})) : null;
  let values=normalizeValues(safeRead(store.values,null)) || defaults.map(v=>({...v}));
  let profiles=safeRead(store.profiles,{});
  if(!profiles || typeof profiles!=='object' || Array.isArray(profiles)) profiles={};
  for(const [name,items] of Object.entries(profiles)) {
    const normalized=normalizeValues(items);
    if(!name || name.length>40 || !normalized) delete profiles[name];
    else profiles[name]=normalized;
  }
  let history=safeRead(store.history,[]);
  if(!Array.isArray(history)) history=[];
  history=history.filter(x=>typeof x==='string').slice(0,60);
  let selectedFile='';
  let toastTimer=null;
  const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const persist = (key,data) => {
    try { localStorage.setItem(key,JSON.stringify(data)); return true; }
    catch(error) { console.error('ZYRON storage error:',error); notify('Local storage is unavailable or full. Export your data before continuing.'); return false; }
  };
  const notify = message => {
    const toast=$('toast');
    if(!toast) return;
    toast.textContent=message;
    toast.classList.add('show');
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>toast.classList.remove('show'),2600);
  };
  const log = message => {
    history=[new Date().toLocaleString()+' • '+message,...history].slice(0,60);
    persist(store.history,history);
    notify(message);
    renderStats();
  };
  const saveValues = () => persist(store.values,values);
  function renderStats() {
    $('overview-count').textContent=values.length;
    $('profile-count').textContent=Object.keys(profiles).length;
    $('profile-count-label').textContent=Object.keys(profiles).length+' PROFILES';
    $('event-count').textContent=history.length;
    $('profiles').innerHTML=Object.keys(profiles).length
      ? Object.keys(profiles).map(name=>'<span class="profile-chip">'+esc(name)+' <button type="button" data-load="'+esc(name)+'" aria-label="Load '+esc(name)+'">Load</button> <button type="button" data-delete-profile="'+esc(name)+'" aria-label="Delete '+esc(name)+'">×</button></span>').join('')
      : '<span class="fine">No saved profiles yet.</span>';
    $('history').innerHTML=history.map(x=>'<div>'+esc(x)+'</div>').join('')||'<span class="fine">No activity yet.</span>';
    const rows=[
      ['Platform',/Android/i.test(navigator.userAgent)?'Android WebView':'Web browser'],
      ['Browser',navigator.userAgent],['Language',navigator.language||'Unknown'],
      ['Storage',storageAvailable?'Local browser storage':'Unavailable'],
      ['Values',values.length],['Profiles',Object.keys(profiles).length]
    ];
    $('diagnostic-rows').innerHTML=rows.map(([a,b])=>'<div class="diag-row"><span>'+esc(a)+'</span><strong>'+esc(String(b))+'</strong></div>').join('');
  }
  function renderValues() {
    const q=$('search').value.trim().toLowerCase(), filter=$('filter').value;
    const min=$('min').value===''?-Infinity:Number($('min').value);
    const max=$('max').value===''?Infinity:Number($('max').value);
    const shown=values.filter(v=>{
      const n=Number(v.value),numeric=v.value.trim()!==''&&Number.isFinite(n);
      return (!q||v.key.toLowerCase().includes(q)||v.value.toLowerCase().includes(q))
        &&(filter!=='Exact'||(q&&v.value.toLowerCase()===q))
        &&(filter!=='Numbers'||v.type!=='TEXT')
        &&(filter!=='Integer'||v.type==='INTEGER')
        &&(filter!=='Decimal'||v.type==='DECIMAL')
        &&(filter!=='Text'||v.type==='TEXT')
        &&(!Number.isFinite(min)||(numeric&&n>=min))
        &&(!Number.isFinite(max)||(numeric&&n<=max));
    });
    $('result-count').textContent=shown.length+' matches · '+values.length+' total';
    $('values').innerHTML=shown.map(v=>'<article class="value-card"><div class="value-top"><div><div class="value-key">'+esc(v.key)+'</div><div class="value-type">'+v.type+'</div></div><div class="value-number">'+esc(v.value)+'</div></div><div class="value-controls">'+(v.type==='INTEGER'?'<button type="button" class="secondary" data-adjust="-1" data-id="'+v.id+'">−1</button><button type="button" class="secondary" data-adjust="1" data-id="'+v.id+'">+1</button>':'')+'<button type="button" class="secondary" data-edit="'+v.id+'">Edit</button><button type="button" class="secondary danger" data-remove="'+v.id+'">Delete</button></div></article>').join('')||'<p class="fine">No matching values.</p>';
  }
  const refresh=()=>{saveValues();renderValues();renderStats();};
  let storageAvailable=true;
  try { const k='zyron_storage_test';localStorage.setItem(k,'1');localStorage.removeItem(k); }
  catch(_) { storageAvailable=false; }
  document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
    document.querySelectorAll('[data-tab]').forEach(item=>item.classList.toggle('active',item===button));
    document.querySelectorAll('.view').forEach(view=>view.classList.toggle('active',view.id===button.dataset.tab));
    $('crumb').textContent=button.textContent.trim().replace(/[0-9]/g,'').replace(/^\S\s+/,'').trim();
    document.body.dataset.view=button.dataset.tab;
    window.scrollTo(0,0);
  }));
  document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>{
    const target=document.querySelector('[data-tab="'+button.dataset.go+'"]');
    if(target) target.click();
  }));
  $('add-form').addEventListener('submit',event=>{
    event.preventDefault();
    const key=$('new-key').value.trim(),value=$('new-value').value.trim();
    if(!key||!value) return;
    if(values.some(v=>v.key.toLowerCase()===key.toLowerCase())) { notify('A value with this name already exists.');return; }
    values.unshift({id:Date.now(),key,value,type:typeOf(value)});
    $('new-key').value='';$('new-value').value='';
    refresh();log('Added local value: '+key);
  });
  ['search','min','max'].forEach(id=>$(id).addEventListener('input',renderValues));
  $('filter').addEventListener('change',renderValues);
  $('values').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    const id=Number(button.dataset.id||button.dataset.edit||button.dataset.remove);
    const item=values.find(v=>v.id===id);if(!item)return;
    if(button.dataset.adjust) {
      const next=Number(item.value)+Number(button.dataset.adjust);
      if(Number.isSafeInteger(next)){item.value=String(next);refresh();log('Adjusted local value: '+item.key);}
      else notify('This value is outside the safe integer range.');
      return;
    }
    if(button.dataset.edit!==undefined) {
      const next=prompt('New value for '+item.key,item.value);
      if(next!==null&&next.trim()){item.value=next.trim();item.type=typeOf(item.value);refresh();log('Edited local value: '+item.key);}
    }
    if(button.dataset.remove!==undefined&&confirm('Delete '+item.key+'?')) {
      values=values.filter(v=>v.id!==id);refresh();log('Deleted local value: '+item.key);
    }
  });
  $('save-profile').addEventListener('click',()=>{
    const name=$('profile-name').value.trim();
    if(!name){notify('Enter a profile name first.');return;}
    if(name.length>40){notify('Profile names must be 40 characters or fewer.');return;}
    const previous=profiles[name];profiles[name]=values.map(v=>({...v}));
    if(!persist(store.profiles,profiles)){if(previous)profiles[name]=previous;else delete profiles[name];return;}
    $('profile-name').value='';renderStats();log('Saved profile: '+name);
  });
  $('profiles').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    const name=button.dataset.load||button.dataset.deleteProfile;
    if(button.dataset.load!==undefined&&profiles[name]) {
      values=profiles[name].map(v=>({...v}));refresh();log('Loaded profile: '+name);
    }
    if(button.dataset.deleteProfile!==undefined&&confirm('Delete profile '+name+'?')) {
      const previous=profiles[name];delete profiles[name];
      if(!persist(store.profiles,profiles)){profiles[name]=previous;return;}
      renderStats();log('Deleted profile: '+name);
    }
  });
  $('export').addEventListener('click',()=>{
    try {
      const blob=new Blob([JSON.stringify(values,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download='zyron-values.json';document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);log('Exported local values');
    } catch(error) { console.error(error);notify('Export failed in this browser.'); }
  });
  $('file-input').addEventListener('change',async event=>{
    const file=event.target.files&&event.target.files[0];if(!file)return;
    const extension=(file.name.split('.').pop()||'').toLowerCase();
    if(!['txt','json','xml'].includes(extension)){notify('Choose a TXT, JSON or XML file.');event.target.value='';return;}
    if(file.size>1024*1024){notify('File is larger than the 1 MB limit.');event.target.value='';return;}
    try {
      selectedFile=await file.text();
      $('file-name').textContent=file.name;
      $('preview').textContent=selectedFile.slice(0,12000);
      $('import').disabled=extension!=='json';
      notify(extension==='json'?'JSON file ready to import.':'File preview loaded.');
      log('Opened selected file: '+file.name);
    } catch(error) { selectedFile='';$('import').disabled=true;notify('Could not read the selected file.'); }
  });
  $('import').addEventListener('click',()=>{
    try {
      const data=JSON.parse(selectedFile);
      if(!Array.isArray(data)||data.length>1000)throw Error('Expected a JSON array with at most 1000 entries.');
      const incoming=data.map((item,index)=>{
        if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Invalid object at item '+(index+1)+'.');
        const key=String(item.key??'').trim(),value=String(item.value??'').trim();
        if(!key||key.length>60||!value||value.length>200)throw Error('Each item needs a name (1–60 chars) and value (1–200 chars). Item '+(index+1)+'.');
        return {id:Date.now()+index,key,value,type:typeOf(value)};
      });
      const merged=new Map(values.map(v=>[v.key.toLowerCase(),v]));
      incoming.forEach(v=>merged.set(v.key.toLowerCase(),v));
      const previous=values;values=Array.from(merged.values());
      if(!saveValues()){values=previous;renderValues();return;}
      renderValues();log('Imported '+incoming.length+' JSON values.');
    } catch(error) { notify('JSON import failed: '+error.message); }
  });
  $('file-input').addEventListener('click',()=>{selectedFile='';$('import').disabled=true;});
  // CPM Lab: local-only demonstration. Never connects to or modifies the game.
  const cpmStoreKey='zyron_cpm_demo_v1';
  const cpmLimits={coins:500000,cash:50000000};
  const cpmDefault={coins:0,cash:0,playerId:''};
  let cpmDemo=safeRead(cpmStoreKey,cpmDefault);
  if(!cpmDemo||typeof cpmDemo!=='object')cpmDemo={...cpmDefault};
  cpmDemo={
    coins:Number.isSafeInteger(cpmDemo.coins)&&cpmDemo.coins>=0&&cpmDemo.coins<=cpmLimits.coins?cpmDemo.coins:0,
    cash:Number.isSafeInteger(cpmDemo.cash)&&cpmDemo.cash>=0&&cpmDemo.cash<=cpmLimits.cash?cpmDemo.cash:0,
    playerId:typeof cpmDemo.playerId==='string'?cpmDemo.playerId.slice(0,32):''
  };
  const cpmFormat=n=>new Intl.NumberFormat('tr-TR').format(n);
  const renderCpmDemo=()=>{
    $('cpm-demo-coins').textContent=cpmFormat(cpmDemo.coins);
    $('cpm-demo-cash').textContent=cpmFormat(cpmDemo.cash);
    $('cpm-player-id').value=cpmDemo.playerId;
  };
  const saveCpmDemo=()=>persist(cpmStoreKey,cpmDemo);
  $('cpm-verify').addEventListener('click',()=>{
    const id=$('cpm-player-id').value.trim();
    if(!/^[A-Za-z0-9_-]{4,32}$/.test(id)){
      $('cpm-verify-result').textContent='ID biçimi uygun değil. 4–32 harf, rakam, tire veya alt çizgi kullan.';
      $('cpm-verify-result').classList.add('invalid');
      return;
    }
    cpmDemo.playerId=id;
    saveCpmDemo();
    $('cpm-verify-result').textContent='Biçim uygun. Bu, hesap sahipliğini doğrulamaz ve oyun sunucusuna bağlanmaz.';
    $('cpm-verify-result').classList.remove('invalid');
  });
  $('cpm-app-select').addEventListener('change',()=>{
    $('cpm-demo-message').textContent='Seçim yalnızca bu yerel demo panelini etiketler; haricî uygulama açılmaz.';
  });
  $('cpm-amount').addEventListener('input',()=>{
    const kind=$('cpm-currency').value;
    $('cpm-amount').max=String(cpmLimits[kind]);
  });
  $('cpm-currency').addEventListener('change',()=>{
    const kind=$('cpm-currency').value;
    $('cpm-amount').max=String(cpmLimits[kind]);
    $('cpm-amount').value=String(cpmLimits[kind]);
  });
  document.querySelectorAll('[data-cpm-preset]').forEach(button=>button.addEventListener('click',()=>{
    const kind=button.dataset.cpmPreset;
    $('cpm-currency').value=kind;
    $('cpm-amount').max=String(cpmLimits[kind]);
    $('cpm-amount').value=String(cpmLimits[kind]);
  }));
  $('cpm-apply-demo').addEventListener('click',()=>{
    const kind=$('cpm-currency').value;
    const raw=$('cpm-amount').value;
    const amount=Number(raw);
    if(!Number.isSafeInteger(amount)||amount<0||amount>cpmLimits[kind]){
      $('cpm-demo-message').textContent='Geçersiz miktar. Coin üst sınırı 500.000, para üst sınırı 50.000.000.';
      return;
    }
    cpmDemo[kind]=amount;
    if(!saveCpmDemo())return;
    renderCpmDemo();
    $('cpm-demo-message').textContent='Demo bakiyesi yerel ZYRON kaydına uygulandı. Gerçek CPM bakiyesi değişmedi.';
    log('Updated local CPM '+kind+' demo balance');
  });
  $('cpm-reset-demo').addEventListener('click',()=>{
    cpmDemo.coins=0;cpmDemo.cash=0;
    if(!saveCpmDemo())return;
    renderCpmDemo();
    $('cpm-demo-message').textContent='Yerel demo bakiyesi sıfırlandı. Gerçek oyun hesabına işlem yapılmadı.';
    log('Reset local CPM demo balance');
  });
  renderCpmDemo();
  const platformLabel=$('platform');
  if(platformLabel)platformLabel.textContent=/Android/i.test(navigator.userAgent)?'ANDROID APP':'WEB WORKSPACE';
  if(!storageAvailable)notify('Browser storage is blocked. Exported files are your backup.');
  renderValues();renderStats();
  if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('ZYRON offline cache unavailable:',error));
})();