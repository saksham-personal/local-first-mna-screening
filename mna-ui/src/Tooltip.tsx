import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import './tooltip.css';

export default function Tooltip({ label, children }: { label: string; children: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position,setPosition] = useState({top:0,left:0,width:250});
  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {const width=Math.min(250,window.innerWidth-32);setPosition({top:Math.min(rect.bottom+8,window.innerHeight-130),left:Math.max(16,Math.min(rect.left,window.innerWidth-width-16)),width});}
    setOpen(true);
  };
  return <span className="help-tip">
    <button ref={trigger} type="button" className="help-tip-trigger" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open} onClick={show} onFocus={show} onKeyDown={(event) => { if(event.key === 'Escape') setOpen(false); }} onBlur={() => setOpen(false)} onMouseEnter={show} onMouseLeave={() => setOpen(false)}><CircleHelp size={15}/></button>
    {open && createPortal(<span id={id} className="help-tip-content" style={{position:'fixed',...position,zIndex:1200}} role="tooltip">{children}</span>,document.body)}
  </span>;
}
