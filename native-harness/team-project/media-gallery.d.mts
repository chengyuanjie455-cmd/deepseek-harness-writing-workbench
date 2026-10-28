import type React from 'react';
export type GalleryItem={id:string;bundleId?:string;bundleable?:boolean;name:string;kind:'image'|'video';src?:string;download?:string;poster?:string;bytes?:number;source?:string;ownerName?:string;model?:string;seconds?:number;width?:number;height?:number;created?:string;[key:string]:any};
export type GalleryProps={items:GalleryItem[];bundleUrl?:string;bundleCount?:number;title?:string;selectedId?:string;load?:(item:GalleryItem)=>Promise<string>;compact?:boolean;empty?:string;onSelect?:(item:GalleryItem)=>void;onDownload?:(item:GalleryItem)=>void};
export function createMediaGallery(react:typeof React,css?:string):React.ComponentType<GalleryProps>;
export const galleryCSS:string;
