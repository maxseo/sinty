export interface SentAttachment {name:string; previewPath?:string}
export function sentAttachments(sessionId:string,seq:unknown,value:unknown):SentAttachment[]{
 if(!Array.isArray(value))return[];return value.slice(0,100).map((item,index)=>{
 const a=item&&typeof item==="object"?item as Record<string,unknown>:{};
 const name=typeof a.name==="string"&&a.name?a.name.slice(0,180):"файл";
 const image=typeof a.mime==="string"&&/^image\/(png|jpeg|gif|webp)$/.test(a.mime)&&typeof a.blob==="string"&&/^sha256:[a-f0-9]{64}$/.test(a.blob)&&Number.isSafeInteger(seq)&&Number(seq)>0;
 return{name,...(image?{previewPath:"/v1/sessions/"+encodeURIComponent(sessionId)+"/attachments/"+seq+"/"+index}:{})};
 });
}
