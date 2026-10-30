import type { UiElement } from '../types';
export function arrangeAssets(elements:UiElement[]) {
  let x=24,y=24,rowHeight=0;
  const items=elements.map(element=>{
    const width=element.slice?.width??element.rect.w;
    const height=element.slice?.height??element.rect.h;
    const scale=Math.min(1,400/Math.max(width,height));
    const w=Math.max(1,width*scale),h=Math.max(1,height*scale);
    if(x+w>1256){x=24;y+=rowHeight+24;rowHeight=0;}
    const item={id:element.id,x,y,w,h};
    x+=w+24;rowHeight=Math.max(rowHeight,h);
    return item;
  });
  return {items,width:1280,height:Math.max(200,y+rowHeight+24)};
}
