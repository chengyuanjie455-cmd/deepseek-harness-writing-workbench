import React from 'react';
import {createMediaGallery,galleryCSS} from '../native-harness/team-project/media-gallery.mjs';
export type {GalleryItem} from '../native-harness/team-project/media-gallery.mjs';
export const MediaGallery=createMediaGallery(React,galleryCSS);
