// Import old host database conversations through the official migration codecs.
// Native on-disk conversations are migrated by SessionPersistence itself.
import {releasedV3SessionFormatCodec as codec,historicalChildCatalogSource} from '/opt/harness/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js';
import {createSessionFormatCatalogWithChildren} from '/opt/harness/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js';
export function upgradeLegacySessions(items){
 const old=items.filter(item=>item.header.version===3).map(item=>({
  ...item,header:{...item.header,delegationDepth:item.header.delegationDepth??0},
  inheritedEventCount:item.inheritedEventCount??(item.header.isSeeded?item.events.find(e=>e.type==='session/end-seed'&&e.data?.inherited)?.seq:0)
 }));
 const byId=new Map(old.map(item=>[item.header.id,item]));
 const catalog=createSessionFormatCatalogWithChildren(old.filter(item=>item.header.origin==='subagent'&&item.header.parentSession).map(historicalChildCatalogSource));
 return items.map(item=>{
  if(item.header.version===4)return item;
  const source=byId.get(item.header.id);if(!source)throw Error('Unsupported legacy conversation format: '+item.header.version);
  const reader=catalog.createRestore(codec.encodeHeader(source.header,source.inheritedEventCount),{recovery:'strict',validation:'current'});
  for(const event of source.events)reader.decodeRow(codec.encodeEvent(event));
  return {...item,...reader.finish()};
 });
}
