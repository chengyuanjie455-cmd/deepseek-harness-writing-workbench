import {resolve} from 'node:path';
import {verifyNativeCompatibility} from '../server/native-compatibility.ts';
console.log(JSON.stringify(verifyNativeCompatibility(resolve('.')),null,2));
