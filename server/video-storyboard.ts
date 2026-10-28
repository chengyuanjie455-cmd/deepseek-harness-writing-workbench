import {readFileSync} from 'node:fs';
import {hash,type Doc,type Store} from './store.ts';
export const STORYBOARD_VERSION='2026.09.27.3';
export const STORYBOARD_SKILL='video-storyboard';
export type VideoFamily='wan3'|'seedance';
export const storyboardEnabled=(store:Store)=>store.get('video-storyboard-policy','active')?.enabled===true;
export function videoFamily(model:Doc):VideoFamily|undefined {
 const remote=String(model.remoteModel??'').normalize('NFKC').toLowerCase();
 if(/(?:wan|wang|万相)[\s-]*3[.]0(?:\D|$)/.test(remote))return 'wan3';
 if(/seedance|seedanc(?:[\s-]|$)|(?:^|[^a-z])sd[\s-]*(?:[12](?:\.[025])?|(?:480|720|1080)(?:fast|mini|满血))(?:[^a-z0-9]|$)/.test(remote))return 'seedance';
}
export function storyboardSkill(){const body=readFileSync(new URL('../video-skills/video-storyboard/SKILL.md',import.meta.url),'utf8');return {id:STORYBOARD_SKILL,version:STORYBOARD_VERSION,sha256:hash(body)};}
