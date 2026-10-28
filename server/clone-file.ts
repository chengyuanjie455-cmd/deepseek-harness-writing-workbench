import {copyFileSync,constants,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname} from 'node:path';

// Node's macOS COPYFILE_FICLONE can fall back to reading every byte. The
// system cp uses clonefile on APFS; cloned files remain independently writable.
export function cloneFileSync(source:string,target:string){
 if(process.platform==='darwin'&&statSync(source).dev===statSync(dirname(target)).dev)execFileSync('/bin/cp',['-c',source,target],{stdio:'pipe',timeout:120000});
 else copyFileSync(source,target,constants.COPYFILE_FICLONE);
}
