import {requireOptionalNativeModule} from 'expo-modules-core';
type Bridge={
  upload:(id:string,url:string,uri:string,headers:Record<string,string>)=>Promise<{status:number;body:string}>;
  cancel:(id:string)=>Promise<void>;
  addListener:(event:'progress',listener:(event:{id:string;fraction:number})=>void)=>{remove:()=>void};
};
/** Raw streaming body; redirects are disabled before credentials leave the app. */
export const FileTransfer=requireOptionalNativeModule<Bridge>('FileTransfer');
