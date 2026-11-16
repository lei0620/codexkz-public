const allowed=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);

export async function fetchReleaseResponse(input,{fetchImpl=fetch,signal,accept='application/octet-stream'}={}){
  let url=new URL(input);
  for(let redirects=0;redirects<=4;redirects++){
    if(url.protocol!=='https:'||url.port||url.username||url.password||!allowed.has(url.hostname))throw Error('下载重定向目标不受信任');
    const response=await fetchImpl(url,{redirect:'manual',signal,headers:{'Accept':accept}});
    if(![301,302,303,307,308].includes(response.status))return response;
    if(redirects===4)throw Error('下载重定向过多');
    const location=response.headers.get('location');if(!location)throw Error('下载重定向缺少地址');
    url=new URL(location,url);
  }
}
