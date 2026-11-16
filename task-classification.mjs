// Two-stage local classification: task intent first, then its concrete subject.
// Section names stay portable in the existing one-level schema.
const normalize=value=>value.normalize('NFKC').toLowerCase().trim();
const prefix=/^(视觉|功能|交互)\s*[-—–:：]\s*(.+)$/u;
const legacyGroups=new Set(['界面体验','数据存储','任务执行','跨机同步','测试验收','项目文档']);
const signals={
  视觉:/视觉|样式|外观|美化|颜色|配色|背景色|字体|字号|排版|圆角|阴影|边框|间距|留白|宽度|高度|尺寸|对齐|布局|图标|滚动条|固定在.{0,4}底部|简化.{0,8}(展示|详情)/gu,
  交互:/交互|点击|双击|拖拽|拖动|键盘|快捷键|焦点|悬停|折叠|展开|滚轮|滚动(?!条)|切换|操作反馈|无反应/gu,
  功能:/智能整理|任务整理|对话采集|自动归卡|自动记录|采集|审阅|版本|回滚|功能|新建|创建|新增|添加|保存|删除|上传|下载|导入|导出|同步|数据库|sqlite|存储|备份|事务|迁移|接口|api\b|登录|权限|认证|调度|执行|队列|分类|识别|匹配|模块|版块|板块|搜索|筛选|测试|验收|文档|readme|交接/gu
};
// A constraint such as “不修改按钮样式” should not override the requested work.
const requested=text=>normalize(text).split(/[，。；;！!\n]/u).filter(part=>!/(?:^\s*(?:但|并且|并)?\s*(?:不改|不修改|不要修改|无需修改|不涉及|不调整|不需要修改)|保持.{0,60}不变|维持.{0,60}原样)/u.test(part)).join(' ');
const uniqueBest=rows=>{const ranked=rows.filter(row=>row.score>0).sort((a,b)=>b.score-a.score);return {best:ranked[0]&&ranked[0].score>(ranked[1]?.score??0)?ranked[0]:null,tied:ranked.length>1&&ranked[0].score===ranked[1].score};};
function intent(text){
  // Business verbs often name the object (e.g. 新建任务按钮颜色). Only use
  // them when no visual/interaction intent is stated at this level.
  const rows=Object.entries(signals).map(([name,pattern])=>({name,score:new Set(text.match(pattern)??[]).size}));
  // Clicking can describe how a business failure is reproduced, not its scope.
  if(!rows[0].score&&!/交互|双击|拖拽|拖动|键盘|快捷键|焦点|悬停|折叠|展开|滚轮|操作反馈/u.test(text)&&/(?:保存|删除|上传|下载|导入|导出|同步|登录|认证|分类|识别|执行|创建|新建).{0,16}(?:失败|失效|错误|异常|不准确|不生效|没有反应|无反应)/u.test(text))return {category:'功能',ambiguous:false};
  const ui=uniqueBest(rows.filter(row=>row.name!=='功能'));
  if(ui.best||ui.tied)return {category:ui.best?.name??'',ambiguous:ui.tied};
  return {category:rows.find(row=>row.name==='功能').score?'功能':'',ambiguous:false};
}
const topics={
  视觉:[['按钮样式',['按钮']],['下拉样式',['下拉','选择器']],['卡片样式',['卡片']],['表单样式',['表单']],['弹窗样式',['弹窗','弹框','对话框']],['导航样式',['导航','侧栏','状态栏']],['任务详情',['任务详情','任务说明与附件']],['滚动条样式',['滚动条']],['文字样式',['字体','字号']],['页面布局',['页面','界面']]],
  交互:[['按钮操作',['按钮']],['下拉选择',['下拉','选择器']],['表单操作',['表单']],['弹窗操作',['弹窗','弹框','对话框']],['导航切换',['导航','侧栏','状态栏','页签']],['卡片操作',['卡片']],['任务详情',['任务详情','任务说明与附件']],['滚动操作',['滚动','滚轮']],['键盘操作',['键盘','快捷键','焦点']]],
  功能:[['智能整理',['智能整理','任务整理']],['对话采集',['对话采集','自动归卡','自动记录','采集']],['新建任务',['新建任务','创建任务','添加任务']],['任务编辑',['编辑任务','修改任务']],['任务分类',['任务分类','版块分类','版块','板块','分类','自动识别','模块选择']],['附件管理',['附件','上传','下载']],['任务执行',['任务执行','执行','调度','队列','审批','依赖','审阅']],['数据存储',['数据库','sqlite','存储','事务','迁移','单写入']],['数据备份',['备份','恢复数据']],['跨机同步',['同步','跨机','跨电脑','远端']],['数据导入导出',['导入','导出']],['账号权限',['登录','认证','权限','账号']],['搜索筛选',['搜索','筛选']],['版本管理',['版本','回滚']],['项目管理',['项目绑定','新建项目','创建项目']],['测试验收',['测试','验收','回归','压测']],['项目文档',['文档','readme','交接','使用说明']],['接口服务',['接口','api']]]
};
const generalTopics={视觉:'界面样式',交互:'操作流程',功能:'业务逻辑'};
function matchingWords(text,words){
  const hits=words.filter(word=>text.includes(word));
  return hits.filter(word=>!hits.some(other=>other!==word&&other.includes(word)));
}
function subject(category,title,description){
  const vocabulary=topics[category].flatMap(([,words])=>words),titleHits=matchingWords(title,vocabulary),bodyHits=matchingWords(description,vocabulary);
  const rows=topics[category].map(([name,words])=>({name,score:words.some(word=>titleHits.includes(word))?10:words.some(word=>bodyHits.includes(word))?1:0}));
  // Prefer a concrete component over a generic page, typography or input method.
  const general=category==='视觉'?['页面布局','文字样式']:category==='交互'?['滚动操作','键盘操作']:[];
  if(rows.some(row=>!general.includes(row.name)&&row.score>=10))for(const row of rows)if(general.includes(row.name))row.score=0;
  const {best}=uniqueBest(rows);
  return best?.name??generalTopics[category];
}
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const genericWords=new Set(['任务','功能','优化','修复','新增','增加','实现','问题','处理','支持','需要','相关','当前','版块','说明','自动','完善','调整','检查','修改','按钮','页面']);
function terms(text){return [...new Set([...segmenter.segment(requested(text))].filter(item=>item.isWordLike&&item.segment.length>1&&!genericWords.has(item.segment)).map(item=>item.segment))];}
export function describeSection(name,keywords=[]){
  const parsed=prefix.exec(normalize(name)),topic=parsed?.[2]??name;
  const focus={视觉:'关注视觉一致性、信息层次和不同屏幕下的呈现效果',交互:'关注操作流程、状态反馈及键盘操作的可用性',功能:'关注业务行为、数据正确性及异常处理'}[parsed?.[1]];
  const aliases=parsed?topics[parsed[1]].find(([label])=>normalize(label)===topic)?.[1]??[]:[];
  const related=[...new Set([...keywords,...aliases].map(word=>word.trim()).filter(word=>word&&!normalize(topic).includes(normalize(word))))].slice(0,6);
  return `本版块聚焦${topic}。${focus?focus+'。':''}${related.length?'相关主题：'+related.join('、')+'。':''}具体修改范围与验收要求以当前任务说明为准。`;
}
export function suggestSection(sections,projectId,title,description){
  const cleanTitle=requested(title),cleanDescription=requested(description),explicit=prefix.exec(normalize(title));
  const first=intent(cleanTitle),genericTitle=/^(?:优化|完善|调整|改进|修复)?(?:一下|功能|问题)?$/u.test(cleanTitle);
  const detected=!genericTitle&&(first.category||first.ambiguous)?first:intent(cleanDescription);
  const category=explicit?.[1]??detected.category;
  if(!category&&detected.ambiguous)return {category:'',sectionName:'',sectionId:null,reason:'同时涉及视觉与交互，保存后按任务标题独立分组，也可调整版块'};
  const local=sections.filter(section=>section.projectId===projectId);
  const topic=explicit?.[2]??(category?subject(category,cleanTitle,cleanDescription):'');
  const titleTopic=category?subject(category,cleanTitle,''):'';
  const titleTerms=terms(cleanTitle),bodyTerms=terms(cleanDescription);
  const ranked=uniqueBest(local.flatMap(section=>{
    const parsed=prefix.exec(normalize(section.name));
    if(parsed&&category&&parsed[1]!==category)return [];
    const name=parsed?.[2]??normalize(section.name);
    const exact=cleanTitle.includes(normalize(section.name))||cleanTitle.includes(name);
    // Broad legacy groups need an explicit name; their generic keywords must
    // not steal a concrete component. Custom legacy groups keep their IDs.
    if(!parsed&&legacyGroups.has(section.name)&&!exact)return [];
    const aliases=category?topics[category].find(([topic])=>normalize(topic)===name)?.[1]??[]:[];
    const words=[...new Set([...(section.keywords??[]),...aliases].map(normalize))].filter(word=>word.length>1);
    const titleMatch=words.some(word=>cleanTitle.includes(word)),bodyMatch=words.some(word=>cleanDescription.includes(word));
    const generated=section.description===describeSection(section.name,section.keywords??[]);
    const sectionTerms=new Set(generated?[]:terms(section.description??''));
    const contextTitle=titleTerms.filter(word=>sectionTerms.has(word)).length,contextBody=bodyTerms.filter(word=>sectionTerms.has(word)).length;
    // A concrete detected subject must beat an incidental keyword in the body.
    const score=exact?40:parsed&&name===normalize(titleTopic)&&titleTopic!==generalTopics[category]?32:titleMatch?24:contextTitle>=2?18:cleanDescription.includes(name)?12:bodyMatch?8:contextBody>=2?2:0;
    return [{name:section.name,section,score:score+(parsed&&score?1:0)}];
  }));
  if(ranked.tied&&!explicit)return {category,sectionName:'',sectionId:null,reason:'多个已有版块同样匹配，保存后按任务标题独立分组，也可调整版块'};
  if(ranked.best&&!explicit){const section=ranked.best.section;return {category:category||prefix.exec(normalize(section.name))?.[1]||'',sectionName:section.name,sectionId:section.id,reason:`先识别任务内容，匹配已有版块“${section.name}”`};}
  if(!category)return {category:'',sectionName:'',sectionId:null,reason:'暂未明确匹配已有版块，保存后按任务标题独立分组，也可调整版块'};
  const name=`${category}-${topic}`;
  if(name.length>80)return {category,sectionName:'',sectionId:null,reason:`已识别为${category}任务，版块名称过长，请手动缩短`};
  const existing=local.find(section=>{const parsed=prefix.exec(normalize(section.name));return parsed?.[1]===category&&parsed[2]===normalize(topic);});
  return {category,sectionName:existing?.name??name,sectionId:existing?.id??null,reason:`先识别为${category}任务，再${existing?'匹配已有':'建议'}版块“${existing?.name??name}”`};
}
