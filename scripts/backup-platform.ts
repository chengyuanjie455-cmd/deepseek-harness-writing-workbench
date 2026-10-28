/** Run with the host and its native containers stopped. No network/API work is performed. */
import {backupOffline,restoreOffline,verifyBackup} from '../server/backup.ts';
const [action,source,destination]=process.argv.slice(2);
if(!['backup','restore','verify'].includes(action)||!source||(action!=='verify'&&!destination))throw Error('用法：tsx scripts/backup-platform.ts backup 数据目录 新备份目录 | restore 备份目录 新恢复目录 | verify 备份目录');
const result=action==='backup'?backupOffline(source,destination):action==='restore'?restoreOffline(source,destination):(()=>{const m=verifyBackup(source);return {verified:true,files:m.files.length,created:m.created};})();console.log(JSON.stringify(result,null,2));
