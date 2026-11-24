/** Authenticated raster fetch; caller owns returned disposal function. Never put a token in src/URL. */
export function loadSentImage(path:string,bearer:string,onUrl:(url:string)=>void,onError:()=>void):()=>void {
 let disposed=false,object="";const controller=new AbortController();
 if(!/^\/v1\/sessions\/[^/?#]+\/attachments\/[1-9]\d*\/\d+$/.test(path)){onError();return()=>{disposed=true}}
 void fetch(path,{headers:{authorization:"Bearer "+bearer},signal:controller.signal,cache:"no-store"}).then(async r=>{
  if(!r.ok)throw Error("unavailable");const b=await r.blob();if(disposed)return;
  if(b.size>16*1024*1024||!/^image\/(png|jpeg|gif|webp)$/.test(b.type))throw Error("unavailable");
  object=URL.createObjectURL(b);onUrl(object);
 }).catch(()=>{if(!disposed)onError()});
 return()=>{disposed=true;controller.abort();if(object){URL.revokeObjectURL(object);object=""}};
}
