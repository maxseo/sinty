/** Tab-memory drafts only: no localStorage, credentials or content logs. */
export class ChatDrafts {
 private owner=""; private rows=new Map<string,{text:string;revision:number}>(); private listeners=new Set<()=>void>();
 selectOwner(owner:string):void { if(owner!==this.owner){this.owner=owner;this.rows.clear();this.emit()} }
 read(owner:string,id:string):{text:string;revision:number}{return owner && owner===this.owner ? {...(this.rows.get(id)??{text:"",revision:0})}:{text:"",revision:0}}
 write(owner:string,id:string,text:string):void {if(!owner||owner!==this.owner)return;const old=this.read(owner,id);this.rows.set(id,{text,revision:old.revision+1});this.emit()}
 sent(owner:string,id:string,revision:number):void {if(owner===this.owner&&this.read(owner,id).revision===revision)this.write(owner,id,"")}
 subscribe(fn:()=>void):()=>void {this.listeners.add(fn);return()=>{this.listeners.delete(fn)}}
 private emit():void {for(const fn of this.listeners)fn()}
}
export const chatDrafts=new ChatDrafts();
export function previewableImage(mime:string):boolean{return /^image\/(png|jpe?g|webp|gif|avif|bmp)$/i.test(mime.split(";")[0]!.trim())}
export class ImagePreviews {
 private urls=new Set<string>();private closed=false;
 constructor(private api:Pick<typeof URL,"createObjectURL"|"revokeObjectURL">=URL){}
 create(file:Blob):string|undefined{if(this.closed||!previewableImage(file.type))return;const url=this.api.createObjectURL(file);this.urls.add(url);return url}
 release(url?:string):void{if(url&&this.urls.delete(url))this.api.revokeObjectURL(url)}
 close():void{this.closed=true;for(const url of [...this.urls])this.release(url)}
 get disposed():boolean{return this.closed}
}
export function clipboardImages(data:Pick<DataTransfer,"items"|"files">|null):File[]{
 if(!data)return[];const fromItems=Array.from(data.items??[]).filter(i=>i.kind==="file"&&previewableImage(i.type)).map(i=>i.getAsFile()).filter((f):f is File=>!!f);
 return fromItems.length ? [...new Set(fromItems)] : Array.from(data.files??[]).filter(f=>previewableImage(f.type));
}
export function keepDialogOpen(e:{key:string;preventDefault():void;stopPropagation():void}):void{if(e.key==="Escape"){e.preventDefault();e.stopPropagation()}}
