import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { buildPremiereBundle } from '../apps/worker/premiere-export.mjs';
import { ffmpegPath } from '../apps/worker/engine.mjs';
import bridge from '../integrations/premiere/bridge.js';
import overlays from '../integrations/premiere/overlays.js';
import hash from '../integrations/premiere/sha256.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rect = (frame, color = '#ff0000') => ({ id: `${frame}-${color}`, kind: 'rect', frame, color, fill: color, opacity: 0.5,
  strokeWidth: 2, points: [], region: { x: .25, y: .25, w: .5, h: .5 } });
const comment = (id, frameIn, frameOut, drawings) => ({ id, versionId: 'v1', text: id, frameIn, frameOut,
  contextFrame: frameIn, sourceRanges: [{ frameIn, frameOut }], drawings });
const state = () => ({ project: { id: 'p', name: 'overlay' }, asset: { width: 320, height: 180 },
  versions: [{ id: 'v1', assetId: 'a', number: 1, label: '원본', status: 'ready', durationFrames: 90,
    timelineMap: [{ sourceIn: 0, sourceOut: 90, outputIn: 0, outputOut: 90, speed: 1 }] }],
  comments: [comment('red',30,60,[rect(30)]), comment('blue',45,75,[rect(45,'#0000ff')])] });
const info = () => ({ projectId: 'p', sequenceId: 's', name: 'sequence', width: 320, height: 180, timebase: '8467200000', endSeconds: 3 });
const bind = bundle => bridge.sequenceBinding(bundle, info());

test('UXP SHA256 matches standard vectors and multi-block binary payloads', () => {
  for (const bytes of [Buffer.alloc(0),Buffer.from('abc'),Buffer.alloc(56,1),Buffer.alloc(64,2),Buffer.alloc(100000,255)]) {
    assert.equal(hash.sha256(bytes), digest(bytes));
    assert.equal(hash.sha256(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), digest(bytes));
  }
});
test('overlapping comments flatten into a single correctly blended transparent lane', async () => {
  const { bundle, timelinePngs } = await buildPremiereBundle(state(),'v1');
  const segments = bundle.timelineOverlays.segments;
  assert.deepEqual(segments.map(s=>[s.frameIn,s.frameOut]), [[30,45],[45,60],[60,75]]);
  for (let i=0;i<segments.length;i++) overlays.validatePng(timelinePngs[i].bytes,segments[i],bundle.canvas);
  const raw = await sharp(timelinePngs[1].bytes).raw().toBuffer();
  assert.equal(raw[3],0);
  const center = [...raw.subarray((90*320+160)*4,(90*320+160)*4+4)];
  assert.ok(center[0]>=83 && center[0]<=86 && center[2]>=168 && center[2]<=172 && center[3]>=190 && center[3]<=193, String(center));
  assert.equal(bundle.videoIncluded,false);
});
test('multiple drawing times replace at the next anchor; points and out-of-range drawings remain explicit', async () => {
  const input = state(); input.comments = [comment('steps',10,60,[rect(20),rect(40,'#0000ff')]),
    comment('point',70,71,[rect(70)]),comment('outside',75,80,[rect(85)])];
  const { bundle } = await buildPremiereBundle(input,'v1');
  assert.deepEqual(bundle.feedback[0].overlays.map(o=>o.displayRanges), [[{frameIn:10,frameOut:40}],[{frameIn:40,frameOut:60}]]);
  assert.deepEqual(bundle.feedback[1].overlays[0].displayRanges,[{frameIn:70,frameOut:71}]);
  assert.deepEqual(bundle.feedback[2].overlays[0].displayRanges,[]);
  assert.equal(bundle.timelineOverlays.skippedGroups,1);
  const b = bind(bundle); b.frameSeconds=1/24;
  const point = structuredClone(bundle); point.timelineOverlays.segments=[{...point.timelineOverlays.segments[2],frameIn:72,frameOut:73}];
  const s = point.timelineOverlays.segments[0]; s.file=`timeline-overlays/vi-${point.scope}-72-73-${s.sha256}.png`;
  // 72->73 collapses to the same host frame at 24fps.
  assert.throws(()=>overlays.overlayPlan(point,b),/짧은/);
});
test('bundle and PNG verification reject overlaps, wrong files, dimensions and missing assets', async () => {
  const { bundle, timelinePngs } = await buildPremiereBundle(state(),'v1');
  const bad=structuredClone(bundle);bad.timelineOverlays.segments[1].frameIn=0;
  assert.throws(()=>bridge.validateBundle(bad));
  const bytes=Buffer.from(timelinePngs[0].bytes);bytes[bytes.length-1]^=1;
  assert.throws(()=>overlays.validatePng(bytes,bundle.timelineOverlays.segments[0],bundle.canvas),/PNG/);
  assert.throws(()=>overlays.validatePng(timelinePngs[0].bytes,bundle.timelineOverlays.segments[0],{width:640,height:360}),/PNG/);
  await assert.rejects(()=>overlays.loadAssets({getEntry:async()=>{throw new Error('missing PNG');}},overlays.overlayPlan(bundle,bind(bundle)),bundle.canvas,'binary'),/missing/);
});

function fakeHost() {
  let locked=false, liveSelection=false;
  const media=[], undo=[], imports=[];
  const mkItem=path=>({ path, duration:5, getMediaFilePath:async()=>path,
    getFootageInterpretation:async()=>({ALPHACHANNEL_STRAIGHT:1,setAlphaUsage:n=>n===1,setIgnoreAlpha:n=>!n,setInvertAlpha:n=>!n,setPixelAspectRatio:n=>n===1}),
    createSetFootageInterpretationAction:()=>()=>{},
    createSetInOutPointsAction(start,end){assert.equal(start.seconds,0);return()=>{this.duration=end.seconds;};} });
  const clip=(item,start,end)=>({item,start,end,getProjectItem:async()=>item,getStartTime:async()=>({seconds:start}),getEndTime:async()=>({seconds:end})});
  const video=mkItem('/video.mp4');
  const trackList=[{items:[clip(video,0,3)],muted:false},{items:[],muted:false}];
  const audio=[{path:'/audio.wav',start:0,end:3}];
  const root={getItems:async()=>media};
  const sequence={guid:'s',name:'sequence',getFrameSize:async()=>({width:320,height:180}),getEndTime:async()=>({seconds:3}),getTimebase:async()=>'8467200000',
    getSettings:async()=>({PAR_SQUARE:'square',getVideoPixelAspectRatio:async()=>sequence.par}),par:'square',
    getVideoTrackCount:async()=>trackList.length,getVideoTrack:async index=>({getTrackItems:type=>type===1?trackList[index].items:[],isMuted:async()=>trackList[index].muted})};
  const project={guid:'p',getActiveSequence:async()=>sequence,getRootItem:async()=>root,
    importFiles:async(paths,suppress,target,numbered)=>{assert.equal(suppress,true);assert.equal(target,root);assert.equal(numbered,false);imports.push(...paths);media.push(...paths.map(mkItem));return true;},
    lockedAccess:fn=>{locked=true;try{fn();}finally{locked=false;}},
    executeTransaction:fn=>{assert.equal(locked,true);const actions=[];fn({addAction:a=>actions.push(a)});undo.push(trackList.map(t=>t.items.slice()));actions.forEach(a=>a());return true;}};
  const editor={createOverwriteItemAction:(item,start,index,audioIndex)=>{assert.ok(media.includes(item), 'overwrite receives the base ProjectItem, not its ClipProjectItem adapter');assert.equal(locked,true);assert.equal(audioIndex,-1);const duration=item.duration;
    return()=>{trackList[index].items.push(clip(item,start.seconds,start.seconds+duration));};},
    createRemoveItemsAction:(selection,ripple,mediaType,shift)=>{assert.equal(liveSelection,true);assert.equal(ripple,false);assert.equal(shift,false);assert.equal(mediaType,'video');
      return()=>{assert.equal(liveSelection,true);trackList.forEach(t=>{t.items=t.items.filter(i=>!selection.items.includes(i));});};}};
  const api={Project:{getActiveProject:async()=>project},Constants:{PixelAspectRatio:{SQUARE:'square'},MediaType:{VIDEO:'video'}},
    TickTime:{createWithSeconds:seconds=>({seconds})},SequenceEditor:{getEditor:()=>editor},
    ClipProjectItem:{cast:item=>{if(!item.path)throw Error('not clip');return {
      getMediaFilePath: item.getMediaFilePath, getFootageInterpretation: item.getFootageInterpretation,
      createSetFootageInterpretationAction: item.createSetFootageInterpretationAction,
      createSetInOutPointsAction: item.createSetInOutPointsAction.bind(item),
    };}},FolderItem:{cast:item=>{if(!item.getItems)throw Error('not folder');return item;}},
    TrackItemSelection:{createEmptySelection:fn=>{liveSelection=true;try{fn({items:[],addItem(item){this.items.push(item);return true;}});}finally{liveSelection=false;}return true;}}};
  return {api,trackList,audio,imports,sequence,media,addUser:()=>trackList[1].items.push(clip(video,0,.5)),undo:()=>{undo.pop().forEach((items,i)=>{trackList[i].items=items;});}};
}
const assetPaths=plan=>plan.map(segment=>({...segment,path:`/persistent/${segment.file}`}));
test('native adapter overwrites one lane without ripple, reuses media, replaces idempotently and undoes',async()=>{
  const {bundle}=await buildPremiereBundle(state(),'v1'), binding=bind(bundle), host=fakeHost();
  const original=host.trackList[0].items.slice(),audio=structuredClone(host.audio);
  let inspection=await overlays.inspect(host.api,bundle,binding);
  assert.equal(inspection.target.index,1);
  assert.deepEqual(await overlays.applyOverlays(host.api,bundle,binding,assetPaths(inspection.plan),inspection.fingerprint),{added:3,replaced:0,track:2});
  const first=host.trackList[1].items.map(i=>[i.item.path,i.start,i.end]);
  assert.deepEqual(first.map(i=>i.slice(1)),[[1,1.5],[1.5,2],[2,2.5]]);
  inspection=await overlays.inspect(host.api,bundle,binding);
  assert.deepEqual(await overlays.applyOverlays(host.api,bundle,binding,assetPaths(inspection.plan),inspection.fingerprint),{added:3,replaced:3,track:2});
  assert.equal(host.imports.length,3);assert.deepEqual(host.trackList[1].items.map(i=>[i.item.path,i.start,i.end]),first);
  host.addUser();await assert.rejects(()=>overlays.inspect(host.api,bundle,binding),/다른 클립/);host.trackList[1].items.pop();
  const empty=structuredClone(bundle);empty.timelineOverlays.segments=[];
  await overlays.applyOverlays(host.api,empty,binding,[]);
  assert.equal(host.trackList[1].items.length,0);host.undo();assert.equal(host.trackList[1].items.length,3);
  assert.deepEqual(host.trackList[0].items,original);assert.deepEqual(host.audio,audio);
});
test('native adapter refuses occupied/muted tracks, mismatched sequences, changed preview and non-square pixels before import',async()=>{
  const {bundle}=await buildPremiereBundle(state(),'v1'),binding=bind(bundle);
  const host=fakeHost();host.addUser();await assert.rejects(()=>overlays.inspect(host.api,bundle,binding),/비어/);assert.equal(host.imports.length,0);
  host.trackList[1].items=[];host.trackList[1].muted=true;await assert.rejects(()=>overlays.inspect(host.api,bundle,binding),/비어/);
  host.trackList[1].muted=false;host.sequence.par='wide';await assert.rejects(()=>overlays.inspect(host.api,bundle,binding),/정사각형/);
  host.sequence.par='square';host.sequence.guid='other';await assert.rejects(()=>overlays.inspect(host.api,bundle,binding),/바뀌/);
  host.sequence.guid='s';const inspection=await overlays.inspect(host.api,bundle,binding);
  host.trackList.push({items:[],muted:false});await assert.rejects(()=>overlays.applyOverlays(host.api,bundle,binding,assetPaths(inspection.plan),inspection.fingerprint),/트랙 배치/);
  assert.equal(host.imports.length,0);
});

test('native FFmpeg confirms transparent placement and exact IN/OUT appearance over separate video',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vi-overlay-render-'));
  try {
    const {bundle,timelinePngs}=await buildPremiereBundle(state(),'v1');
    // NUT keeps exact 1/30 s timestamps; Matroska rounds to milliseconds, which makes IN/OUT boundaries version-dependent.
    const source=join(directory,'source.nut');
    execFileSync(ffmpegPath,['-y','-v','error','-f','lavfi','-i','color=c=black:s=320x180:r=30:d=3','-c:v','ffv1',source]);
    const before=digest(await readFile(source));
    const args=['-v','error','-i',source], filters=[];
    for(let i=0;i<timelinePngs.length;i++) {
      const path=join(directory,`${i}.png`);await writeFile(path,timelinePngs[i].bytes);args.push('-loop','1','-framerate','30','-i',path);
      const segment=bundle.timelineOverlays.segments[i];
      filters.push(`[${i===0?'0:v':`v${i}`}][${i+1}:v]overlay=0:0:enable='gte(t,${segment.frameIn/30})*lt(t,${segment.frameOut/30})':format=rgb[v${i+1}]`);
    }
    args.push('-filter_complex',filters.join(';'),'-map',`[v${timelinePngs.length}]`,'-frames:v','90','-pix_fmt','rgb24','-f','rawvideo','pipe:1');
    const raw=execFileSync(ffmpegPath,args,{maxBuffer:32*1024*1024});
    const pixel=(frame,x=160,y=90)=>[...raw.subarray((frame*320*180+y*320+x)*3,(frame*320*180+y*320+x)*3+3)];
    for(const frame of [29,75,89])assert.deepEqual(pixel(frame),[0,0,0]);
    for(const frame of [30,44]){const p=pixel(frame);assert.ok(p[0]>=125&&p[0]<=130&&p[2]===0,String(p));}
    for(const frame of [45,59]){const p=pixel(frame);assert.ok(p[0]>=60&&p[0]<=67&&p[2]>=125&&p[2]<=130,String(p));}
    for(const frame of [60,74]){const p=pixel(frame);assert.ok(p[0]===0&&p[2]>=125&&p[2]<=130,String(p));}
    assert.deepEqual(pixel(50,0,0),[0,0,0]);assert.equal(digest(await readFile(source)),before);
  } finally {await rm(directory,{recursive:true,force:true});}
});
