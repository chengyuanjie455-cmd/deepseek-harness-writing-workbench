import {isAbsolute} from 'node:path';
export function enduranceOptions(env:NodeJS.ProcessEnv){
 const report=env.ENDURANCE_REPORT;if(!report||!isAbsolute(report))throw Error('ENDURANCE_REPORT must be an absolute new receipt path');
 const hours=Number(env.ENDURANCE_HOURS??24),intervalMs=Number(env.ENDURANCE_INTERVAL_MS??300000);
 if(!Number.isFinite(hours)||hours<=0||!Number.isFinite(hours*3600000))throw Error('ENDURANCE_HOURS must be positive and finite');
 if(!Number.isSafeInteger(intervalMs)||intervalMs<1000)throw Error('ENDURANCE_INTERVAL_MS must be an integer >=1000');
 const rounds=env.ENDURANCE_ROUNDS===undefined?undefined:Number(env.ENDURANCE_ROUNDS);
 if(rounds!==undefined&&(!Number.isSafeInteger(rounds)||rounds<4))throw Error('ENDURANCE_ROUNDS must include at least four rounds for recovery verification');
 return {report,durationMs:hours*3600000,intervalMs,rounds,mode:rounds===undefined?'duration' as const:'bounded_rounds' as const};
}
