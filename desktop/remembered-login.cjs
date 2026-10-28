const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const same=(a,b)=>a.origin===b.origin&&a.serverId===b.serverId;

class RememberedLogin {
  constructor({filename,storage,connection,target,platform=process.platform}) {
    Object.assign(this,{filename,storage,connection,target,platform});this.busy=false;this.restorePromise=undefined;this.autoLoginPaused=false;
  }
  available() {return this.platform==='darwin'&&this.storage.isEncryptionAvailable();}
  async scope() {
    const c=this.connection,scope={origin:c.origin,serverId:c.serverId,epoch:c.epoch};
    const h=await this.target();
    if(!h?.managed||h.url!==scope.origin||h.serverId!==scope.serverId||!/^http:\/\/127\.0\.0\.1:\d+$/.test(scope.origin)||!same(c,scope)||c.epoch!==scope.epoch)throw Error('只能在已核验的本机主机管理端记住超管登录');
    return scope;
  }
  read(scope) {
    if(!fs.existsSync(this.filename))return null;
    if(!this.available())throw Error('钥匙串暂不可用，已保存登录记录仍保留；解锁后重新打开应用即可。');
    const stat=fs.lstatSync(this.filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error('已保存登录记录无效，请清除后重新登录');
    try {
      const box=JSON.parse(fs.readFileSync(this.filename,'utf8'));
      if(box.version!==1||typeof box.encrypted!=='string')throw Error();
      let plaintext;
      try{plaintext=this.storage.decryptString(Buffer.from(box.encrypted,'base64'));}
      catch{throw Object.assign(Error('钥匙串暂未允许读取，账号密码记录仍保留；完成系统授权后重新打开应用即可。'),{keychainLocked:true});}
      const saved=JSON.parse(plaintext);
      if(!same(saved,scope)) {
        // An explicit local installation fork can retain the owner's encrypted login.
        // Never accept migration instructions from a remote host or another origin.
        const migrationPath=this.filename+'.identity-migration.json';
        if(!fs.existsSync(migrationPath))return null;
        const st=fs.lstatSync(migrationPath);
        if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.size>4096)return null;
        const migration=JSON.parse(fs.readFileSync(migrationPath,'utf8'));
        const digest=createHash('sha256').update(fs.readFileSync(this.filename)).digest('hex');
        if(migration.version!==1||migration.origin!==scope.origin||saved.origin!==scope.origin||migration.from!==saved.serverId||migration.to!==scope.serverId||migration.encryptedSHA256!==digest||saved.role!=='admin')return null;
        if(typeof saved.username!=='string'||typeof saved.password!=='string'||saved.password.length<12)throw Error();
        this.write(scope,saved.username,saved.password,saved.userId);
        fs.renameSync(migrationPath,migrationPath+'.applied');
        saved.serverId=scope.serverId;
      }
      if(typeof saved.username!=='string'||typeof saved.password!=='string'||saved.password.length<12||saved.role!=='admin')throw Error();
      return saved;
    }catch(e){if(e.keychainLocked)throw e;throw Error('已保存登录记录校验失败，请清除无效记录后重新保存。');}
  }
  write(scope,username,password,userId) {
    if(!this.available())throw Error('钥匙串不可用，密码未保存');
    const encrypted=this.storage.encryptString(JSON.stringify({origin:scope.origin,serverId:scope.serverId,username,password,userId,role:'admin'}));
    fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});
    const temporary=this.filename+'.'+randomUUID()+'.tmp';let fd;
    try {
      fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({version:1,encrypted:encrypted.toString('base64')}));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temporary,this.filename);
    }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  async status() {
    const scope=await this.scope();const supported=this.available();
    try {const saved=supported?this.read(scope):null;return {supported,saved:!!saved,username:saved?.username??'',canClear:fs.existsSync(this.filename),error:supported?'':'钥匙串暂不可用，已保存登录记录仍保留；解锁后重新打开应用即可。'};}
    catch(e){return {supported,saved:false,username:'',canClear:true,error:e.message};}
  }
  async clear() {
    if(this.busy)throw Error('登录正在进行，请稍后清除');
    await this.scope();if(fs.existsSync(this.filename))fs.unlinkSync(this.filename);
    return {cleared:true};
  }
  pauseAutoLogin() { this.autoLoginPaused=true; }
  restore() {
    if(this.restorePromise)return this.restorePromise;
    this.restorePromise=(async()=>{
      if(this.autoLoginPaused)return {status:204,data:{restored:false}};
      const scope=await this.scope();
      if(this.autoLoginPaused)return {status:204,data:{restored:false}};
      const saved=this.read(scope);
      if(!saved)return {status:204,data:{restored:false}};
      return this.login({username:saved.username,useSaved:true,remember:true,automatic:true});
    })().finally(()=>{this.restorePromise=undefined;});
    return this.restorePromise;
  }
  async login(body) {
    if(this.busy)return {status:409,data:{error:'登录正在进行，请稍候'}};
    this.busy=true;
    try {
      const scope=await this.scope(),remember=body?.remember===true,useSaved=body?.useSaved===true;
      if(body?.automatic&&this.autoLoginPaused)return {status:204,data:{restored:false}};
      if(typeof body?.username!=='string'||body.username.length>40)return {status:400,data:{error:'请输入有效账号'}};
      let password=body.password;
      if(useSaved){const saved=this.read(scope);if(!saved||saved.username!==body.username)return {status:409,data:{error:'已保存账号不匹配，请手动输入密码'}};password=saved.password;}
      if(typeof password!=='string'||password.length<12||password.length>256)return {status:400,data:{error:'请输入12至256位密码'}};
      // Revalidate the local identity immediately before any credential is transmitted.
      if(this.connection.epoch!==scope.epoch||!same(this.connection,scope))throw Error('连接选择已变更');
      const result=await this.connection.call('/api/login','POST',{username:body.username,password});
      if(!same(this.connection,scope)||this.connection.epoch!==scope.epoch+(result.status===401?2:1))throw Error('登录身份已变更，未保存密码');
      if(result.status!==200){
        if(useSaved&&result.status===401&&fs.existsSync(this.filename)){fs.unlinkSync(this.filename);result.data.error='已保存登录失效，请重新输入账号密码';}
        return result;
      }
      const user=result.data.user;let credentialNotice='';
      if(remember&&user?.role==='admin'&&user.username===body.username){
        // Reusing the saved account should not rewrite the encrypted record on
        // every launch. Keep the same Keychain item and app identity on updates.
        if(!useSaved)try{this.write(scope,body.username,password,user.id);}catch{credentialNotice='登录成功，但钥匙串保存失败，下次需手动输入。';}
      }else if(remember){
        if(useSaved&&fs.existsSync(this.filename))fs.unlinkSync(this.filename);
        credentialNotice='登录成功；仅超级管理员账号可以在主机端记住密码。';
      }
      else if(fs.existsSync(this.filename)){fs.unlinkSync(this.filename);}
      if(!body?.automatic)this.autoLoginPaused=false;
      return {...result,data:{...result.data,...(credentialNotice?{credentialNotice}:{})}};
    }finally{this.busy=false;}
  }
}
module.exports={RememberedLogin};
