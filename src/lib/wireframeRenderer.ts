import type { LayoutNode } from '../types';
import { orderedLayout } from './layoutStructure';

export function renderCleanWireframe(nodes: LayoutNode[], width: number, height: number, showNames = false): HTMLCanvasElement {
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');
  if(!ctx) throw Error('无法创建画布');
  ctx.fillStyle='#ffffff';
    ctx.fillRect(0,0,width,height);
  for(const node of orderedLayout(nodes)) {
    const x=node.rect.x*width;
    const y=node.rect.y*height;
    const w=Math.max(2,node.rect.w*width);
    const h=Math.max(2,node.rect.h*height);
    const preset=node.preset;
    const fontSize=Math.max(9,Math.min(h*.36,Math.min(width,height)*.04));
    ctx.save();
    ctx.beginPath();
    ctx.rect(x,y,w,h);
    ctx.clip();
    ctx.strokeStyle='#172033';
    ctx.fillStyle='#ffffff';
    ctx.lineWidth=Math.max(1,width/600);
    const box=(bx:number,by:number,bw:number,bh:number)=>ctx.strokeRect(bx+.5,by+.5,Math.max(0,bw-1),Math.max(0,bh-1));
    const label=(text:string,bx:number,by:number,bw:number,bh:number,outline=false)=>{
      ctx.font=`${Math.min(fontSize,Math.max(9,bh*.6))}px sans-serif`;
      ctx.textBaseline='middle';
    ctx.textAlign=node.textAlign??'center';
    ctx.fillStyle='#172033';
      let tx=bx+bw/2;
      if(ctx.textAlign==='left') tx=bx+4;
      else if(ctx.textAlign==='right') tx=bx+bw-4;
      if(outline) ctx.strokeText(text,tx,by+bh/2,Math.max(1,bw-8));
      else ctx.fillText(text,tx,by+bh/2,Math.max(1,bw-8));
    };
    const hatch=(bx:number,by:number,bw:number,bh:number,dots=false)=>{
      ctx.save();
    ctx.beginPath();
    ctx.rect(bx,by,bw,bh);
    ctx.clip();
    ctx.fillStyle='#f1f2f4';
    ctx.fillRect(bx,by,bw,bh);
      ctx.strokeStyle='#8b929e';
    ctx.fillStyle='#8b929e';
    ctx.lineWidth=.7;
      if(dots) {
        for(let py=by+5;py<by+bh;py+=9) for(let px=bx+5;px<bx+bw;px+=9) {ctx.beginPath();
    ctx.arc(px,py,1,0,Math.PI*2);
    ctx.fill();}
      } else {
        for(let offset=-bh;offset<bw;offset+=7) {ctx.beginPath();
    ctx.moveTo(bx+offset,by);
    ctx.lineTo(bx+offset+bh,by+bh);
    ctx.stroke();}
      }
      ctx.restore();box(bx,by,bw,bh);
    };
    if(node.kind==='text') {
      label(node.text??'文本',x,y,w,h,preset==='title');
    } else if(node.kind==='image') {
      hatch(x,y,w,h,preset!=='decoration');
    } else if(node.kind==='icon') {
      if(node.framed) box(x,y,w,h);
      const position=node.textPosition??'bottom';
      let iconW=w,iconH=h;
      if(node.text && (position==='bottom'||position==='above')) iconH=h*.72;
      if(node.text && position==='right') iconW=Math.min(w*.4,h);
      let iconY=y;
      if(node.text && position==='above') iconY=y+h*.28;
      const padding=node.framed?Math.min(6,iconW*.1,iconH*.1):0;
      hatch(x+padding,iconY+padding,iconW-padding*2,iconH-padding*2);
      if(node.text) {
        if(position==='right') label(node.text,x+iconW,y,w-iconW,h);
        else if(position==='above') label(node.text,x,y,w,h*.28);
        else if(position==='corner') label(node.text,x+w*.55,y+h*.65,w*.45,h*.35);
        else label(node.text,x,y+iconH,w,h-iconH);
      }
    } else if(node.kind==='progress') {
      const value=Math.max(0,Math.min(100,node.value??50))/100;
      ctx.fillStyle='#646875';
      if(preset==='radial') {
        const radius=Math.min(w,h)/2-1;
        ctx.beginPath();
    ctx.moveTo(x+w/2,y+h/2);
    ctx.arc(x+w/2,y+h/2,radius,-Math.PI/2,-Math.PI/2+Math.PI*2*value);
    ctx.closePath();
    ctx.fill();
        ctx.beginPath();
    ctx.arc(x+w/2,y+h/2,radius,0,Math.PI*2);
    ctx.stroke();
      } else {
        if(preset==='vertical') ctx.fillRect(x,y+h*(1-value),w,h*value);
        else ctx.fillRect(x,y,w*value,h);
        box(x,y,w,h);
      }
    } else if(node.kind==='button') {
      ctx.fillStyle='#f4f5f7';
    ctx.fillRect(x,y,w,h);box(x,y,w,h);
      if(preset==='icon-label') {const side=Math.min(h*.65,w*.22);hatch(x+w*.1,y+(h-side)/2,side,side);label(node.text??'按钮',x+w*.32,y,w*.6,h);}
      else if(preset==='label'||(!preset&&node.text)) label(node.text??'按钮',x,y,w,h);
    } else {
      box(x,y,w,h);
      if(preset==='card'||preset==='dialog') {
        const header=Math.min(h*.22,32);
    ctx.fillStyle=preset==='card'?'#e5e7eb':'#ffffff';
    ctx.fillRect(x+1,y+1,w-2,header);
        ctx.beginPath();
    ctx.moveTo(x,y+header);
    ctx.lineTo(x+w,y+header);
    ctx.stroke();
        if(node.text) label(node.text,x,y,w,header);
      } else if(preset==='list') {
        ctx.strokeStyle='#adb2bd';
        for(let row=1;row<6;row++) {ctx.beginPath();
    ctx.moveTo(x+8,y+h*row/6);
    ctx.lineTo(x+w-8,y+h*row/6);
    ctx.stroke();}
      }
    }
    if(showNames) {ctx.fillStyle='#677080';
    ctx.font='10px sans-serif';
    ctx.textAlign='left';
    ctx.fillText(node.name,x+3,y+h-4,Math.max(1,w-6));}
    ctx.restore();
  }
  return canvas;
}
