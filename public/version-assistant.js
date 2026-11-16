export function createVersionAssistant({form,dialog,post,readFields,fillFields,onBegin=()=>{}}){
  const section=document.createElement('section');section.className='version-assistant';
  section.innerHTML='<div class="version-assistant-heading"><strong>让 Codex 填写</strong><button type="button" class="primary" data-copy>复制给 Codex</button></div><p class="hint">发到当前项目聊天，结果填入后检查并保存。</p><details data-command hidden><summary>查看通用指令</summary><textarea data-prompt rows="7" readonly aria-label="发给Codex的通用版本记录指令"></textarea></details><p class="hint" data-status role="status"></p><div class="version-assistant-actions"><button type="button" data-apply hidden>填入识别结果</button><button type="button" data-cancel hidden>取消本次识别</button></div>';
  form.querySelector('.dialog-heading').after(section);
  const $=name=>section.querySelector('[data-'+name+']');
  let projectId='',active=null,pending=null,baseline='',sourceId='',epoch=0,working=false,polling=false;
  function suspend(){epoch++;active=null;pending=null;sourceId='';working=false;}
  dialog.addEventListener('close',suspend);
  const message=value=>{$('status').textContent=value;};
  function apply(result){fillFields(result.draft,result.git);sourceId=active.id;active.applied=true;pending=null;$('apply').hidden=true;$('cancel').hidden=true;message('已填入 Codex 结果。'+(result.git?'Git 提交已核验；':'本条未固定 Git 提交；')+'验证和备份说明由 Codex 提供，请检查后保存。');}
  async function prepare(id){
    onBegin();
    const ticket=epoch,pid=projectId,originalFields=JSON.stringify(readFields());working=true;$('copy').disabled=true;message('正在生成当前项目的指令…');
    try{
      const r=await post('versions/command',{projectId:pid,...(id?{id}:{})});
      if(ticket!==epoch||!dialog.open)return null;
      active={id:r.id,prompt:r.prompt,applied:false};baseline=originalFields;
      $('prompt').value=r.prompt;$('command').hidden=false;$('copy').textContent='再次复制指令';$('cancel').hidden=false;
      message('等待 Codex 完成。此窗口打开时会自动识别；关闭后可重新打开继续。');return r.prompt;
    }catch(e){if(ticket===epoch)message(e.message);return null;}
    finally{if(ticket===epoch){working=false;$('copy').disabled=false;}}
  }
  $('copy').onclick=async()=>{
    if(working)return;if(active?.applied){active=null;pending=null;sourceId='';}const ticket=epoch;const prompt=active?.prompt??await prepare();if(!prompt||ticket!==epoch||!dialog.open)return;
    try{await navigator.clipboard.writeText(prompt);if(ticket===epoch)message('通用指令已复制。在执行电脑的当前项目对话发送，结果会填入那台电脑的面板。');}
    catch{if(ticket!==epoch)return;$('command').open=true;$('prompt').focus();$('prompt').select();message('指令已选中，请按 Ctrl+C 复制。');}
  };
  $('apply').onclick=()=>{if(pending)apply(pending);};
  $('cancel').onclick=async()=>{
    if(!active||working)return;const ticket=epoch,id=active.id;working=true;
    try{await post('versions/command/cancel',{projectId,id});if(ticket!==epoch)return;suspend();$('cancel').hidden=true;$('apply').hidden=true;$('command').hidden=true;$('copy').textContent='复制给 Codex';message('已取消识别，现有表单内容保留。');}
    catch(e){if(ticket===epoch)message(e.message);}finally{if(ticket===epoch)working=false;}
  };
  async function poll(){
    if(!active||active.applied||pending||working||polling||!dialog.open||document.hidden||section.hidden||form.querySelector('#saveVersion')?.disabled)return;
    const ticket=epoch,id=active.id,pid=projectId;polling=true;
    try{
      const result=await post('versions/collect',{projectId:pid,id});if(ticket!==epoch||!dialog.open||id!==active?.id)return;
      if(result.status==='ready'){
        if(JSON.stringify(readFields())===baseline)apply(result);
        else{pending=result;$('apply').hidden=false;message('已识别结果。你修改过表单，草稿已保留；点击“填入识别结果”可替换。');}
      }else if(result.status==='saved'){active.applied=true;message('此结果已保存，可关闭窗口查看版本列表。');}
    }catch(e){if(ticket===epoch)message(e.message);}finally{polling=false;}
  }
  setInterval(()=>void poll(),2500);
  return {
    open(id,editing,requests){
      suspend();projectId=id;section.hidden=!!editing;$('copy').disabled=false;$('copy').textContent='复制给 Codex';$('cancel').hidden=true;$('apply').hidden=true;$('command').hidden=true;$('command').open=false;$('prompt').value='';message('');
      if(!editing){const previous=(requests??[]).filter(r=>r.projectId===id&&['waiting','ready'].includes(r.status)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];if(previous)void prepare(previous.id);}
    },
    sourceId:()=>sourceId
  };
}
