const button=document.getElementById('copy-setup');
const status=document.getElementById('copy-status');
button.addEventListener('click',async()=>{
 status.textContent='';
 try{
  const response=await fetch('/setup.md');
  if(!response.ok)throw new Error('guide unavailable');
  const text=await response.text();
  await navigator.clipboard.writeText(text);
  status.textContent='Copied.';
 }catch{
  status.textContent='Copy failed. Open /setup.md and copy it from there.';
 }
});
