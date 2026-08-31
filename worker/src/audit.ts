export function auditDocument(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Andory 别名审核</title>
  <style>
    :root{font-family:"Noto Sans CJK SC","Source Han Sans SC",system-ui,sans-serif;color:#303746;background:#f4f6fa}
    *{box-sizing:border-box}body{margin:0}.shell{width:min(1080px,calc(100% - 32px));margin:42px auto}
    header,.toolbar,.row{background:#fff;border:1px solid #dce2ec;border-radius:14px;box-shadow:0 8px 28px #45506b12}
    header{padding:28px 30px;margin-bottom:16px}h1{margin:0 0 8px;font-size:30px}.muted{color:#838b99}
    .toolbar{display:flex;gap:10px;padding:14px;margin-bottom:16px}input{flex:1;min-width:0;border:1px solid #cfd6e2;border-radius:9px;padding:11px 13px;font:inherit}
    button{border:0;border-radius:9px;padding:10px 16px;font:700 14px inherit;cursor:pointer;background:#4a86f7;color:#fff}button.reject{background:#ec6677}button:disabled{opacity:.45;cursor:default}
    #status{min-height:24px;margin:8px 2px;color:#747d8c}.list{display:grid;gap:12px}.row{padding:18px 20px;display:grid;grid-template-columns:110px 1fr auto;gap:18px;align-items:center}
    .badge{display:inline-flex;justify-content:center;border-radius:999px;padding:7px 12px;font-weight:800;background:#edf3ff;color:#4076d8}.badge.character{background:#f4ebff;color:#8750c7}
    .title{font-size:20px;font-weight:900;margin-bottom:7px}.meta{font-size:14px;color:#7c8492;overflow-wrap:anywhere}.actions{display:flex;gap:8px}
    .empty{padding:48px;text-align:center;color:#87909f;background:#fff;border-radius:14px}@media(max-width:720px){.row{grid-template-columns:1fr}.actions{justify-content:flex-start}.toolbar{flex-wrap:wrap}.toolbar button{flex:1}}
  </style>
</head>
<body><main class="shell">
  <header><h1>Andory 别名审核</h1><div class="muted">歌曲与角色共用审核队列；批准后 JP / global 两服立即共用。</div></header>
  <section class="toolbar"><input id="token" type="password" autocomplete="current-password" placeholder="管理员 Token"><button id="load">载入审核队列</button></section>
  <div id="status"></div><section id="list" class="list"></section>
</main>
<script>
const token=document.querySelector('#token'),list=document.querySelector('#list'),statusBox=document.querySelector('#status');
token.value=sessionStorage.getItem('andoryAuditToken')||'';
document.querySelector('#load').addEventListener('click',load);
async function api(path,options={}){const value=token.value.trim();if(!value)throw new Error('请填写管理员 Token');sessionStorage.setItem('andoryAuditToken',value);const response=await fetch(path,{...options,headers:{authorization:'Bearer '+value,'content-type':'application/json',...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));return data}
async function load(){statusBox.textContent='载入中…';list.replaceChildren();try{const data=await api('/api/v1/audit/aliases');render(data.proposals||[]);statusBox.textContent='共 '+(data.proposals||[]).length+' 条记录'}catch(error){statusBox.textContent=error.message}}
function render(rows){list.replaceChildren();if(!rows.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='暂无别名审核记录';list.append(empty);return}for(const item of rows){const row=document.createElement('article');row.className='row';const badge=document.createElement('span');badge.className='badge '+item.kind;badge.textContent=item.kind==='character'?'角色':'歌曲';const detail=document.createElement('div');const title=document.createElement('div');title.className='title';title.textContent=item.alias+'  →  '+item.targetId;const meta=document.createElement('div');meta.className='meta';meta.textContent='状态 '+item.status+' · 提交 '+new Date(item.submittedAt).toLocaleString()+(item.submittedBy?' · 用户 '+item.submittedBy:'');detail.append(title,meta);const actions=document.createElement('div');actions.className='actions';if(item.status==='pending'){actions.append(actionButton(item,'approve','批准',''),actionButton(item,'reject','拒绝','reject'))}row.append(badge,detail,actions);list.append(row)}}
function actionButton(item,action,label,className){const button=document.createElement('button');button.className=className;button.textContent=label;button.addEventListener('click',async()=>{button.disabled=true;try{await api('/api/v1/audit/aliases/'+encodeURIComponent(item.id),{method:'POST',body:JSON.stringify({action})});await load()}catch(error){statusBox.textContent=error.message;button.disabled=false}});return button}
</script></body></html>`;
}
