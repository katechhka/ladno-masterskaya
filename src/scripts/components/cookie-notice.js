import $ from 'jquery';
const VERSION='2026-10-20';
export function initCookieNotice(){
  const $notice=$('[data-cookie-notice]');if(!$notice.length)return;let returnFocus;let keyboardNavigation=false;
  const known=()=>document.cookie.split(';').some(item=>item.trim()===`ladno_cookie_notice=${VERSION}`);
  const show=()=>{$notice.prop('hidden',false);document.documentElement.style.setProperty('--cookie-height',`${Math.ceil($notice[0].getBoundingClientRect().height)+32}px`);};
  const hide=()=>{$notice.prop('hidden',true);document.documentElement.style.setProperty('--cookie-height','0px');};
  if(!known())show();
  $('[data-cookie-open]').on('click',function(){returnFocus=this;show();$notice.find('[data-cookie-dismiss]').trigger('focus');});
  $notice.find('[data-cookie-dismiss]').on('click',()=>{try{document.cookie=`ladno_cookie_notice=${VERSION}; Max-Age=${180*86400}; Path=/; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`;}catch{/* При запрете cookie закрываем уведомление в текущем документе. */}hide();if(returnFocus)$(returnFocus).trigger('focus');});
  $(document).on('keydown.cookie-notice',event=>{if(event.key==='Tab')keyboardNavigation=true;}).on('pointerdown.cookie-notice',()=>{keyboardNavigation=false;});
  $(document).on('focusin','input,textarea,select,button,a',function(){if(!keyboardNavigation||$notice.prop('hidden')||$.contains($notice[0],this))return;const target=this.getBoundingClientRect();const panel=$notice[0].getBoundingClientRect();if(target.bottom>panel.top&&target.top<panel.bottom&&target.right>panel.left&&target.left<panel.right)window.scrollBy({top:target.bottom-panel.top+24,behavior:'instant'});});
}
