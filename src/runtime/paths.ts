import { lstatSync,realpathSync } from 'node:fs';
import { join,normalize,parse,relative,resolve } from 'node:path';

/** Check existing components before creating a worker or lock; junctions and file aliases are not valid stores. */
export function validateFilesystemPath(input:string,expected:'FILE'|'DIRECTORY'):void {
  const path=resolve(input),root=parse(path).root;
  const parts=relative(root,path).split(/[\\/]/u).filter(Boolean);
  let current=root;
  for(let index=0;index<parts.length;index++){
    current=join(current,parts[index]!);
    let information:ReturnType<typeof lstatSync>;
    try{information=lstatSync(current);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('Filesystem path could not be verified');}
    if(information.isSymbolicLink())throw new Error('Filesystem links are forbidden');
    const canonical=normalize(realpathSync.native(current)),requested=normalize(current);
    if((process.platform==='win32'?canonical.toLowerCase():canonical)!==(process.platform==='win32'?requested.toLowerCase():requested))throw new Error('Filesystem aliases are forbidden');
    const final=index===parts.length-1;
    if(!final||expected==='DIRECTORY'){if(!information.isDirectory())throw new Error('Directory path required');}
    else if(!information.isFile()||information.nlink>1)throw new Error('A regular independent database file is required');
  }
}
