// Use the host's curl transport (including its normal proxy settings); artifact hashes
// are still checked by @electron/get against the pinned official npm checksum list.
const {execFile}=require('node:child_process');const {promisify}=require('node:util');
const exec=promisify(execFile);
module.exports={download:async(url,target)=>{await exec('curl',['--fail','--location','--silent','--show-error','--connect-timeout','20','--max-time','240','--output',target,url],{maxBuffer:1024*1024});}};
