import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readSync } from "node:fs";
import { join } from "node:path";
export const ATTACHMENT_PREVIEW_MAX = 16 * 1024 * 1024;
/** Raster preview only. No caller path, metadata MIME, SVG, symlink, hardlink or unbounded read. */
export function readAttachmentPreview(dataDir:string, blob:unknown):{bytes:Buffer;mime:string}|undefined {
 if(typeof blob!=="string"||!/^sha256:[a-f0-9]{64}$/.test(blob))return;
 const hex=blob.slice(7),dir=join(dataDir,"blobs"),file=join(dir,hex);let fd:number|undefined;
 try {
  if(lstatSync(dir).isSymbolicLink())return;
  const canonical=realpathSync(dir),before=lstatSync(file);
  if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1||realpathSync(file)!==join(canonical,hex))return;
  fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const st=fstatSync(fd);
  if(!st.isFile()||st.nlink!==1||st.ino!==before.ino||st.dev!==before.dev||st.size<8||st.size>ATTACHMENT_PREVIEW_MAX)return;
  const bytes=Buffer.alloc(st.size);let n=0;while(n<bytes.length){const got=readSync(fd,bytes,n,bytes.length-n,n);if(!got)return;n+=got}
  if(fstatSync(fd).size!==st.size||createHash("sha256").update(bytes).digest("hex")!==hex)return;
  let mime="";if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime="image/png";
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime="image/jpeg";
  else if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString("ascii")))mime="image/gif";
  else if(bytes.length>=12&&bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP")mime="image/webp";
  if(mime)return{bytes,mime};
 }catch{return}finally{if(fd!==undefined)closeSync(fd)}
}
