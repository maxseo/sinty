import {loadSentImage} from "./sent-image-loader.js";
import {useEffect,useRef,useState} from "preact/hooks";
import {token} from "./api.js";
import type {SentAttachment} from "./sent-attachment-ref.js";
export function SentAttachmentView({file}:{file:SentAttachment}){
 const ref=useRef<HTMLSpanElement>(null),[visible,setVisible]=useState(false),[url,setUrl]=useState(""),[failed,setFailed]=useState(false);
 useEffect(()=>{if(!file.previewPath)return;const el=ref.current;if(!el)return;if(typeof IntersectionObserver==="undefined"){setVisible(true);return}const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect()}},{rootMargin:"300px"});observer.observe(el);return()=>observer.disconnect()},[file.previewPath]);
 useEffect(()=>{if(!visible||!file.previewPath)return;setUrl("");setFailed(false);return loadSentImage(file.previewPath,token.get(),setUrl,()=>setFailed(true))},[visible,file.previewPath]);
 return <span class={"sent-attachment"+(file.previewPath?" image":"")} ref={ref}>{url?<a href={url} target="_blank" rel="noopener noreferrer" title="Открыть изображение"><img src={url} alt={file.name} loading="lazy" decoding="async" onError={()=>{setFailed(true);setUrl("")}}/></a>:file.previewPath&&!failed?<span class="muted small">Изображение…</span>:null}<span class="sent-attachment-name">{file.name}{failed?" · предпросмотр недоступен":""}</span></span>
}
