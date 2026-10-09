import { lstatSync,realpathSync } from 'node:fs';
import { isAbsolute,join,normalize,parse,relative,resolve } from 'node:path';

/** Reject Windows alternate streams, device names, drive-relative paths and file aliases. */
export function validatePathSyntax(input:string):void {
  if(input.length<1||input.length>1024||/\p{C}/u.test(input)||input.startsWith('\\\\')||input.startsWith('//')) throw new Error('Invalid filesystem path');
  const root=parse(input).root;
  if(process.platform==='win32'&&root&&!isAbsolute(input)) throw new Error('Drive-relative paths are forbidden');
  const parts=input.slice(root.length).split(/[\\/]/u).filter(Boolean);
  if(!parts.length||parts.some(part=>part==='.'||part==='..')) throw new Error('Invalid filesystem path');
  if(process.platform==='win32'&&parts.some(part=>/[:<>"|?*]/u.test(part)||/[. ]$/u.test(part)||/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part))) throw new Error('Filesystem aliases are forbidden');
}

/** Check existing components before creating a worker or lock; junctions and file aliases are not valid stores. */
export function validateFilesystemPath(input:string,expected:'FILE'|'DIRECTORY'):void {
  validatePathSyntax(input);
  if(!isAbsolute(input)||!['FILE','DIRECTORY'].includes(expected)) throw new Error('An absolute filesystem path is required');
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
