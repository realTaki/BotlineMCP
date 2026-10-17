const el=id=>document.getElementById(id);
el('generate').addEventListener('click',()=>{
 el('instance').value=Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
 el('output').hidden=false;el('generate').disabled=true;
});
el('clear').addEventListener('click',()=>{el('instance').value='';el('output').hidden=true;el('generate').disabled=false;});
