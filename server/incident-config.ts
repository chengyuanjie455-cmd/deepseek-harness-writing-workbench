import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {IncidentOptions} from './incidents.ts';

/** Both the normal and desktop-managed entry points use the same host-only config. */
export function loadIncidentConfig(dataDir:string,explicit=process.env.PLATFORM_INCIDENT_CONFIG):IncidentOptions|undefined {
 const filename=explicit?resolve(explicit):join(dataDir,'incident-config.json');
 if(!explicit&&!existsSync(filename))return undefined;
 const config=JSON.parse(readFileSync(filename,'utf8'));
 if(!config||Array.isArray(config)||typeof config!=='object')throw Error('故障处理配置必须是 JSON 对象');
 return config;
}
