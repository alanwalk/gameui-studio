import { useEffect, useRef, useState, type ReactNode } from 'react';

export function PanZoomSurface({width,height,label,children,picking,onColor,onBackgroundClick,overlay}: {
  width:number;height:number;label:string;children:ReactNode;picking?:boolean;onColor?:(color:string)=>void;
  onBackgroundClick?:()=>void;overlay?:ReactNode;
}) {
  const host=useRef<HTMLDivElement>(null);
  const [camera,setCamera]=useState({x:20,y:20,zoom:1});
  const drag=useRef<{x:number;y:number;left:number;top:number;moved:boolean}|null>(null);
  const suppressClick=useRef(false);
  const manual=useRef(false);
  const fit=()=>{
    if(!host.current)return;
    const zoom=Math.min((host.current.clientWidth-40)/width,(host.current.clientHeight-40)/height);
    setCamera({zoom:Math.max(.02,zoom),x:(host.current.clientWidth-width*zoom)/2,y:(host.current.clientHeight-height*zoom)/2});
  };
  useEffect(()=>{fit();},[width,height]);
  useEffect(()=>{
    const element=host.current;if(!element)return;
    const observer=new ResizeObserver(()=>{if(!manual.current)fit();});
    observer.observe(element);return()=>observer.disconnect();
  },[width,height]);
  useEffect(()=>{
    const element=host.current;if(!element)return;
    const wheel=(event:WheelEvent)=>{
      event.preventDefault();
    const box=element.getBoundingClientRect();
      manual.current=true;
      const x=event.clientX-box.left,y=event.clientY-box.top;
      const delta=event.deltaMode===1?event.deltaY*16:event.deltaY;
      setCamera(current=>{
        const zoom=Math.max(.02,Math.min(8,current.zoom*Math.exp(-delta*.0015)));
        return {zoom,x:x-(x-current.x)*zoom/current.zoom,y:y-(y-current.y)*zoom/current.zoom};
      });
    };
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);
  },[]);
  return <div className={`panzoom-surface ${picking?'is-picking':''}`} ref={host} aria-label={label}
    onPointerDown={event=>{
      if(event.button!==0&&event.button!==1)return;
      if((event.target as HTMLElement).closest('.surface-fit'))return;
      suppressClick.current=false;
      drag.current={x:event.clientX,y:event.clientY,left:camera.x,top:camera.y,moved:false};
    }} onPointerMove={event=>{
      const start=drag.current;if(!start)return;
      const dx=event.clientX-start.x,dy=event.clientY-start.y;
      if(Math.abs(dx)+Math.abs(dy)>4)start.moved=true;
      if(start.moved) {
        manual.current=true;
        if(!event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.setPointerCapture(event.pointerId);
        setCamera(current=>({...current,x:start.left+dx,y:start.top+dy}));
      }
    }} onPointerUp={event=>{
      suppressClick.current=drag.current?.moved??false;
    drag.current=null;
      if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={()=>{drag.current=null;}} onClickCapture={event=>{
      if((event.target as HTMLElement).closest('.surface-fit')) {suppressClick.current=false;return;}
      if(suppressClick.current){event.preventDefault();
    event.stopPropagation();return;}
      const target = event.target as HTMLElement;
      if (target === event.currentTarget || target.classList.contains('panzoom-world')) onBackgroundClick?.();
      if(!picking || target.closest('.surface-fit'))return;
      event.preventDefault();
    event.stopPropagation();
      const image=(event.target as HTMLElement).closest('img');
      if(!image || !image.complete || !image.naturalWidth)return;
      const bounds=image.getBoundingClientRect();
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const context=canvas.getContext('2d');if(!context)return;
      context.drawImage(image,0,0);
      const x=Math.max(0,Math.min(image.naturalWidth-1,Math.floor((event.clientX-bounds.left)/bounds.width*image.naturalWidth)));
      const y=Math.max(0,Math.min(image.naturalHeight-1,Math.floor((event.clientY-bounds.top)/bounds.height*image.naturalHeight)));
      const rgba=context.getImageData(x,y,1,1).data;
      const bytes=[...rgba];if(rgba[3]===255)bytes.pop();
      onColor?.('#'+bytes.map(value=>value.toString(16).padStart(2,'0')).join('').toUpperCase());
    }}>
    <div className="panzoom-world" style={{width,height,transform:`translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`}}>{children}</div>
    {overlay}
    <button className="surface-fit" onClick={()=>{manual.current=false;fit();}}>适应 · {Math.round(camera.zoom*100)}%</button>
  </div>;
}
