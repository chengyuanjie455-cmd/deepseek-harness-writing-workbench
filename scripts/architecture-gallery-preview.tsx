import React from 'react';import {createRoot} from 'react-dom/client';import {createMediaGallery,galleryCSS} from '../native-harness/team-project/media-gallery.mjs';
const Gallery=createMediaGallery(React,galleryCSS);createRoot(document.getElementById('root')!).render(<Gallery title="图片与视频 · 原件独立保留" items={(window as any).galleryItems}/>);
