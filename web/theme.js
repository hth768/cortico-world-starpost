// Stores appearance only. Runs before CSS paint to avoid a bright flash at night.
(() => {
  const key='starpost-appearance',media=matchMedia('(prefers-color-scheme: dark)');let mode='system';
  try{const saved=localStorage.getItem(key);if(['light','dark','system'].includes(saved))mode=saved}catch{}
  const apply=()=>{const dark=mode==='dark'||mode==='system'&&media.matches;document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.style.colorScheme=dark?'dark':'light';document.querySelector('meta[name="theme-color"]')?.setAttribute('content',dark?'#11121b':'#f9f9ff');dispatchEvent(new CustomEvent('starpost-theme',{detail:{mode,dark}}))};
  window.starpostAppearance={get mode(){return mode},set(value){if(!['system','light','dark'].includes(value))return;mode=value;try{localStorage.setItem(key,mode)}catch{}apply()}};
  media.addEventListener('change',()=>{if(mode==='system')apply()});apply();
})();
