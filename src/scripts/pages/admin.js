import $ from 'jquery';
import { money, formatDate, formatTime, dayKey, shiftDay } from '../services/dates.js';
import { preparePhoto } from '../services/photo-upload.js';

export function initAdmin() {
  const $root = $('[data-admin-content]'); let csrf = ''; let data; let busy = false;
  const nameOf = (id) => data.workshops.find((w) => w.id === id)?.title || 'Программа в архиве';
  const notice = (text, error = false) => $('<p>', { class: `notice${error ? ' notice--error' : ' notice--success'}`, role: error ? 'alert' : 'status' }).text(text);
  async function request(path, method = 'GET', body) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/admin${path}`, { method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 && path !== '/login') { csrf = ''; login(true); }
        throw Object.assign(new Error(result.error?.message || 'Не удалось сохранить изменения.'), { fields: result.error?.fields });
      }
      return result;
    } catch (error) { if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('Сервер не ответил. Проверьте соединение. Перед повтором откройте список и проверьте, сохранилось ли изменение.'); throw error; }
    finally { clearTimeout(timer); }
  }
  const button = (text, click, secondary = true) => $('<button>', { type: 'button', class: `button${secondary ? ' button--secondary' : ''}` }).text(text).on('click', click);
  const input = (name, label, value = '', options = {}) => {
    const { textarea, choices, help, ...attributes } = options;
    const $control = choices ? $('<select>', { class: 'field__input', name, ...attributes }).append(choices.map(([value, label]) => $('<option>', { value }).text(label))) : $(`<${textarea ? 'textarea' : 'input'}>`, { class: 'field__input', name, ...attributes });
    $control.val(value);
    return $('<label>', { class: `field${textarea ? ' admin__wide' : ''}` }).append($('<span>', { class: 'field__label' }).text(label), $control, help ? $('<span>', { class: 'field__help' }).text(help) : []);
  };
  const checkbox = (name, label, checked = false) => $('<label>', { class: 'admin__check' }).append($('<input>', { type: 'checkbox', name, checked }), $('<span>').text(label));
  function saveForm($form, callback) {
    $form.on('submit', async (event) => {
      event.preventDefault(); if (busy) return; busy = true;
      const $submit = $form.find('[type=submit]'); $submit.prop('disabled', true);
      $form.find('[data-form-error]').remove(); $form.find('[aria-invalid]').removeAttr('aria-invalid');
      try { await callback($form[0]); }
      catch (error) {
        $form.prepend(notice(error.message, true).attr({ 'data-form-error': '', tabindex: '-1' }));
        for (const key of Object.keys(error.fields || {})) { const control = $form[0].elements.namedItem(key.replace(/^program\./, '')); if (control?.setAttribute) control.setAttribute('aria-invalid', 'true'); }
        $form.find('[data-form-error]').trigger('focus');
      } finally { busy = false; $submit.prop('disabled', false); }
    });
  }
  function login(expired = false) {
    $root.empty(); if (expired) $root.append(notice('Время входа истекло. Войдите снова.', true));
    const $form = $('<form>', { class: 'admin__login' }).append($('<h2>').text('Вход для хозяйки'), $('<p>').text('Программы, расписание и записи — в одном месте.'),
      input('username', 'Логин', '', { required: true, autocomplete: 'username', maxlength: 100 }),
      input('password', 'Пароль', '', { type: 'password', required: true, autocomplete: 'current-password', maxlength: 200 }),
      $('<button>', { class: 'button', type: 'submit' }).text('Войти в мастерскую ↗'));
    saveForm($form, async (form) => { const result = await request('/login', 'POST', { username: form.username.value, password: form.password.value }); csrf = result.csrf; form.password.value = ''; await load(); }); $root.append($form);
  }
  function go(view, edit = '') {
    const url = new URL(location.href); url.search = ''; url.searchParams.set('view', view); if (edit) url.searchParams.set('edit', edit);
    history.pushState({}, '', url); render();
  }
  async function load(message = '') { data = await request('/data'); render(); if (message) $root.find('[data-admin-workspace]').prepend(notice(message)); }
  function render() {
    if (!data || !csrf) return;
    $root.empty(); const params = new URLSearchParams(location.search); const view = ['programs','sessions','bookings'].includes(params.get('view')) ? params.get('view') : 'programs';
    const $nav = $('<nav>', { class: 'admin__nav', 'aria-label': 'Разделы управления' });
    for (const [key, title] of [['programs','Мастер-классы'],['sessions','Расписание'],['bookings','Записи']]) $nav.append(button(title, () => go(key)).attr('aria-current', key === view ? 'page' : null));
    $nav.append(button('Выйти', async () => { try { await request('/logout', 'POST', {}); csrf = ''; data = null; login(); } catch (error) { $root.prepend(notice(error.message,true)); } }));
    const $workspace = $('<div>', { 'data-admin-workspace': '' }); $root.append($nav, $workspace);
    const edit = params.get('edit');
    if (view === 'programs') edit ? programForm($workspace, edit) : programs($workspace);
    if (view === 'sessions') edit ? sessionForm($workspace, edit) : sessions($workspace);
    if (view === 'bookings') bookings($workspace, params.get('session') || '');
  }
  function programs($area) {
    $area.append($('<div>', { class: 'admin__toolbar' }).append($('<h2>').text('Мастер-классы'), button('Добавить программу ↗', () => go('programs','new'), false)),
      $('<p>', { class: 'admin__muted' }).text('Правки сразу появляются на сайте. Архив скрывает программу и закрывает новые записи; история броней сохраняется.'));
    const $list = $('<div>', { class: 'admin__list' });
    for (const w of data.workshops) $list.append($('<article>', { class: 'admin__row', 'data-program-id': w.id }).append(
      $('<img>', { class: 'admin__thumb', src: `/media/${w.image}-480.webp`, alt: '', loading: 'lazy', width: 100, height: 76 }),
      $('<div>', { class: 'admin__row-copy' }).append($('<span>', { class: 'admin__tag' }).text(w.archived ? 'В архиве' : 'На сайте'), $('<h3>').text(w.title), $('<p>').text(`${money(w.priceRub)} · ${w.durationMinutes} мин · ${w.minAge}+`)),
      button('Редактировать', () => go('programs',w.id))));
    $area.append($list);
  }
  function programForm($area, id) {
    const existing = data.workshops.find((w) => w.id === id); if (!existing && id !== 'new') { $area.append(notice('Программа не найдена.',true)); return; }
    const w = existing || { id: `program-${crypto.randomUUID()}`, slug: '', title: '', category: data.site.categories[0].id, priceRub: 2500, durationMinutes: 120, minAge: 12, capacity: 8, level: 'Без опыта', teacherId: data.teachers[0].id, process: [], materials: [], relatedIds: [], gallery: [] };
    $area.append(button('← К списку программ', () => go('programs')), $('<h2>').text(existing ? 'Редактируем программу' : 'Новая программа'));
    const $form = $('<form>', { class: 'admin__form', 'data-program-form': '' });
    const fields = [
      input('title','Название',w.title,{required:true,maxlength:150}), input('slug','Адрес страницы',w.slug,{required:true,readonly:Boolean(existing),pattern:'[a-z0-9]+(-[a-z0-9]+)*',maxlength:100,help:existing?'Постоянный адрес сохраняется при переименовании.':'Латинские буквы и дефисы, например vecher-akvareli.'}),
      input('category','Направление',w.category,{choices:data.site.categories.map((c)=>[c.id,c.name])}), input('teacherId','Преподаватель',w.teacherId,{choices:data.teachers.map((t)=>[t.id,t.name])}),
      input('priceRub','Цена за участника, ₽',w.priceRub,{type:'number',min:1,max:100000,required:true}), input('durationMinutes','Длительность, минуты',w.durationMinutes,{type:'number',min:30,max:480,required:true}),
      input('minAge','Минимальный возраст',w.minAge,{type:'number',min:6,max:18,required:true}), input('capacity','Обычный размер группы',w.capacity,{type:'number',min:1,max:20,required:true}),
      input('level','Уровень подготовки',w.level,{required:true,maxlength:100}), input('image','Обложка',w.image || Object.keys(data.images)[0],{choices:Object.values(data.images).map((image)=>[image.id,image.alt])}),
      input('summary','Краткое описание',w.summary,{textarea:true,rows:3,required:true,maxlength:1000}), input('process','Как проходит занятие',w.process.join('\n'),{textarea:true,rows:5,required:true,maxlength:6000,help:'Каждый шаг с новой строки. Минимум три шага.'}),
      input('result','Что участник сделает',w.result,{textarea:true,rows:2,required:true,maxlength:2000}), input('materials','Материалы в стоимости',w.materials.join('\n'),{textarea:true,rows:5,required:true,maxlength:3000,help:'Каждый материал с новой строки. Минимум четыре пункта.'}),
      input('preparation','Одежда и подготовка',w.preparation,{textarea:true,rows:3,required:true,maxlength:2000}), input('pickup','Когда и как забрать работу',w.pickup,{textarea:true,rows:3,required:true,maxlength:2000}),
      input('relatedIds','Рекомендуемые занятия',w.relatedIds,{choices:data.workshops.filter((item)=>item.id!==w.id).map((item)=>[item.id,item.title]),multiple:true,size:4,required:true,help:'Выберите не менее двух. На компьютере удерживайте Ctrl / Cmd.'})
    ];
    $form.append($('<div>',{class:'admin__fields'}).append(fields));
    const $gallery = $('<fieldset>', { class:'admin__media' }).append($('<legend>').text('Галерея: выберите от 2 до 6 разных кадров'));
    function addImage(image,checked=false){$gallery.append($('<label>',{class:'admin__media-item'}).append($('<img>',{src:`/media/${image.id}-480.webp`,alt:'',loading:'lazy',width:160,height:110}),$('<span>').text(image.alt),$('<input>',{type:'checkbox',name:'gallery',value:image.id,checked})));}
    for (const image of Object.values(data.images)) addImage(image,w.gallery.includes(image.id));
    const $upload=$('<section>',{class:'admin-upload','data-photo-upload':''}).append($('<h3>').text('Свои фотографии'),$('<p>',{class:'admin__muted'}).text('JPEG, PNG или WebP: до 10 МБ и 40 мегапикселей, минимум 480 × 320. За один раз — до 6 фото. Метаданные снимков удаляются. Загружайте фотографии, которые вправе публиковать.'));
    const $files=$('<input>',{class:'field__input',type:'file',name:'photos',multiple:true,accept:'image/jpeg,image/png,image/webp','aria-label':'Выбрать фотографии'});
    const $previews=$('<div>',{class:'admin-upload__previews'});const $uploadStatus=$('<div>',{'data-upload-status':'','aria-live':'polite'});let chosen=[];let urls=[];
    const $uploadButton=button('Загрузить фотографии',async()=>{
      if(!chosen.length)return;const descriptions=$previews.find('[data-photo-alt]').toArray().map(el=>el.value.trim());
      if(descriptions.some(alt=>alt.length<8||alt.length>250)){$uploadStatus.empty().append(notice('Опишите каждую фотографию: от 8 до 250 символов.',true));$previews.find('[data-photo-alt]').first().trigger('focus');return;}
      busy=true;$uploadButton.prop('disabled',true);$files.prop('disabled',true);$form.find('[type=submit]').prop('disabled',true);
      let completed=0;
      try{
        for(let i=0;i<chosen.length;i++){
          $uploadStatus.empty().append($('<p>',{role:'status'}).text(`Готовим фото ${i+1} из ${chosen.length}…`));
          const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60000);let result;
          try{const photo=await preparePhoto(chosen[i]);const response=await fetch('/api/admin/media',{method:'POST',credentials:'same-origin',headers:{'Content-Type':photo.type,'X-CSRF-Token':csrf,'X-Image-Alt':encodeURIComponent(descriptions[i])},body:photo,signal:controller.signal});result=await response.json();if(!response.ok)throw new Error(result.error?.message||'Не удалось загрузить фотографию.');}finally{clearTimeout(timer);}
          const image=result.image;data.images[image.id]=image;addImage(image,true);$form.find('[name=image]').append($('<option>',{value:image.id}).text(image.alt));
          if(completed===0)$form.find('[name=image]').val(image.id);completed++;
        }
        $uploadStatus.empty().append(notice(`Загружено: ${completed}. Первая фотография выбрана обложкой, все добавлены в галерею. Проверьте выбор и сохраните программу.`));
      }catch(error){$uploadStatus.empty().append(notice(`Сохранено фотографий: ${completed}. ${error.name==='AbortError'?'Сервер не ответил вовремя.':error.message} Уже загруженные фото остаются в медиатеке.`,true));}
      finally{urls.forEach(url=>URL.revokeObjectURL(url));urls=[];chosen=[];$files.val('').prop('disabled',false);$previews.empty();busy=false;$uploadButton.prop('disabled',true);$form.find('[type=submit]').prop('disabled',false);}
    },false).prop('disabled',true);
    $files.on('change',()=>{
      urls.forEach(url=>URL.revokeObjectURL(url));urls=[];chosen=[...$files[0].files];$previews.empty();$uploadStatus.empty();
      if(chosen.length>6||chosen.some(file=>file.size>10*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type))){chosen=[];$files.val('');$uploadButton.prop('disabled',true);$uploadStatus.append(notice('Выберите до шести фотографий JPEG, PNG или WebP, каждая до 10 МБ.',true));return;}
      chosen.forEach((file,i)=>{const url=URL.createObjectURL(file);urls.push(url);const $alt=input(`photoAlt${i}`,`Что изображено на фото ${i+1}?`,'',{maxlength:250,minlength:8,help:'Это описание будет доступно посетителям, использующим экранное чтение.'});$alt.find('input').attr('data-photo-alt','');$previews.append($('<div>',{class:'admin-upload__preview'}).append($('<img>',{src:url,alt:'Предпросмотр выбранной фотографии',width:200,height:140}),$('<p>').text(file.name),$alt));});
      $uploadButton.prop('disabled',!chosen.length);
    });
    $upload.append($files,$previews,$uploadButton,$uploadStatus);$form.append($upload);
    $form.append($gallery, checkbox('archived','Скрыть программу в архив',Boolean(w.archived)), $('<p>',{class:'admin__muted'}).text('Новая цена применяется к новым броням. Суммы подтверждённых записей сохраняются. Длительность и вместимость существующих сеансов меняются отдельно в расписании.'), $('<button>',{type:'submit',class:'button'}).text('Сохранить программу ↗'));
    saveForm($form,async(form)=>{
      const value=(key)=>form.elements.namedItem(key).value.trim(); const lines=(key)=>value(key).split('\n').map((v)=>v.trim()).filter(Boolean);
      const p={id:w.id,slug:value('slug'),title:value('title'),category:value('category'),teacherId:value('teacherId'),priceRub:Number(value('priceRub')),durationMinutes:Number(value('durationMinutes')),minAge:Number(value('minAge')),capacity:Number(value('capacity')),level:value('level'),image:value('image'),imageAlt:data.images[value('image')].alt,summary:value('summary'),process:lines('process'),result:value('result'),materials:lines('materials'),preparation:value('preparation'),pickup:value('pickup'),relatedIds:[...form.relatedIds.selectedOptions].map((o)=>o.value)};
      await request(`/programs/${w.id}`,'PUT',{program:p,gallery:$(form).find('[name=gallery]:checked').map((_,el)=>el.value).get(),archived:form.archived.checked,version:w.version||0});
      history.replaceState({},'', '/admin/?view=programs'); await load('Программа сохранена. Изменения уже на сайте.');
    }); $area.append($form);
  }
  function sessions($area) {
    $area.append($('<div>',{class:'admin__toolbar'}).append($('<h2>').text('Расписание'),button('Добавить занятие ↗',()=>go('sessions','new'),false)),$('<p>',{class:'admin__muted'}).text('Даты и время — по Туле. В мастерской может проходить одно занятие одновременно.'));
    const $date=input('day','Показать день','',{type:'date'}); const $past=checkbox('past','Показать прошедшие занятия'); const $list=$('<div>',{class:'admin__list'}); $area.append($date,$past,$list);
    function draw(){
      const day=$date.find('input').val(); const past=$past.find('input').prop('checked'); $list.empty();
      const list=data.sessions.filter((s)=>(past||new Date(s.startsAt)>new Date())&&(!day||dayKey(s.startsAt)===day));
      if (!list.length) $list.append($('<p>',{class:'empty-state'}).text('В выбранные дни занятий нет.'));
      for(const s of list) $list.append($('<article>',{class:'admin__row'}).append($('<div>',{class:'admin__row-copy'}).append($('<span>',{class:'admin__tag'}).text(`${formatDate(s.startsAt)} · ${formatTime(s.startsAt)}`),$('<h3>').text(nameOf(s.workshopId)),$('<p>').text(`${s.status==='cancelled'?'Отменено':!s.bookingOpen?'Запись закрыта':'Запись открыта'} · занято ${s.capacity-s.available} из ${s.capacity}`)),button('Изменить',()=>go('sessions',s.id)),button('Записи',()=>{const url=new URL('/admin/',location.origin);url.searchParams.set('view','bookings');url.searchParams.set('session',s.id);history.pushState({},'',url);render();})));
    } $date.on('change',draw);$past.on('change',draw);draw();
  }
  function sessionForm($area,id){
    const s=data.sessions.find((s)=>s.id===id);if(!s&&id!=='new'){$area.append(notice('Сеанс не найден.',true));return;}
    const first=data.workshops.find((w)=>!w.archived);if(!first){$area.append(notice('Сначала опубликуйте программу.',true));return;}
    const closed=s&&(s.status==='cancelled'||new Date(s.startsAt)<=new Date());
    $area.append(button('← К расписанию',()=>go('sessions')),$('<h2>').text(s?'Изменить занятие':'Добавить занятие'));
    if(closed){$area.append(notice('Прошедшие и отменённые занятия доступны для просмотра в списке записей.'));return;}
    const local=s?`${dayKey(s.startsAt)}T${formatTime(s.startsAt)}`:`${shiftDay(dayKey(),1)}T18:30`;
    const $form=$('<form>',{class:'admin__form','data-session-form':''});
    $form.append($('<div>',{class:'admin__fields'}).append(input('workshopId','Программа',s?.workshopId||first.id,{choices:data.workshops.filter((w)=>!w.archived||w.id===s?.workshopId).map((w)=>[w.id,w.title]),disabled:Boolean(s)}),input('startsLocal','Дата и время в Туле',local,{type:'datetime-local',required:true}),input('capacity','Количество мест',s?.capacity||first.capacity,{type:'number',min:1,max:20,required:true})),checkbox('bookingOpen','Открыть онлайн-запись',s?Boolean(s.bookingOpen):true));
    if(s)$form.append(checkbox('cancel','Отменить занятие и связанные действующие брони'),$('<p>',{class:'admin__muted'}).text(`Сейчас забронировано мест: ${s.capacity-s.available}. При переносе или отмене нужно лично сообщить участникам. Отправка сообщений не выполняется автоматически.`));
    else {
      const $repeat=$('<details>',{class:'admin__repeat'}).append($('<summary>').text('Повторить в другие дни'));
      $repeat.append(input('repeatUntil','Повторять до','',{type:'date',help:'Не более шести недель. Оставьте пустым для одного занятия.'}));
      const $days=$('<div>',{class:'admin__weekdays'});for(const [value,label]of [[1,'Пн'],[2,'Вт'],[3,'Ср'],[4,'Чт'],[5,'Пт'],[6,'Сб'],[0,'Вс']])$days.append(checkbox(`weekday${value}`,label));
      $repeat.append($days,$('<p>',{'data-repeat-preview':'',role:'status'}));$form.append($repeat);
    }
    function repeats(form){
      const until=form.repeatUntil?.value;if(!until)return[];
      const start=form.startsLocal.value.slice(0,10);if(until<start||until>shiftDay(start,41))throw new Error('Выберите окончание в пределах шести недель от начала.');
      const dates=[];for(let d=start;d<=until;d=shiftDay(d,1)){const weekday=new Date(`${d}T12:00:00+03:00`).getUTCDay();if(form[`weekday${weekday}`]?.checked&&d!==start)dates.push(d);}return dates;
    }
    const preview=()=>{try{const dates=[ $form[0].startsLocal.value.slice(0,10),...repeats($form[0])];$form.find('[data-repeat-preview]').text(`Будет создано ${dates.length}: ${dates.map((d)=>formatDate(d)).join(', ')} в ${$form[0].startsLocal.value.slice(11)}.`);}catch(e){$form.find('[data-repeat-preview]').text(e.message);}};
    $form.on('change','input',preview);preview();
    $form.find('[name=workshopId]').on('change',function(){ $form[0].capacity.value=data.workshops.find((w)=>w.id===this.value).capacity; });
    $form.append($('<button>',{type:'submit',class:'button'}).text('Сохранить расписание ↗'));
    saveForm($form,async(form)=>{
      const body={workshopId:s?.workshopId||form.workshopId.value,startsLocal:form.startsLocal.value,capacity:Number(form.capacity.value),bookingOpen:form.bookingOpen.checked,cancel:form.cancel?.checked||false,version:s?.version||0,dates:repeats(form),confirmed:false};
      if(s&&(body.cancel||body.startsLocal!==local)&&(s.capacity-s.available)>0){if(!confirm(`Изменение затронет ${s.capacity-s.available} участников. После сохранения сообщите им лично. Продолжить?`))return;body.confirmed=true;}
      else if(body.cancel&&!confirm('Отменить занятие? Это действие нельзя отменить.'))return;
      const result=await request(s?`/sessions/${s.id}`:'/sessions',s?'PUT':'POST',body);history.replaceState({},'','/admin/?view=sessions');await load(result.affectedParticipants?'Расписание сохранено. В разделе «Записи» отмечены участники, которым нужно сообщить об изменении.':`Расписание сохранено. Занятий: ${result.count}.`);
    });$area.append($form);
  }
  async function bookings($area,sessionId){
    $area.append($('<h2>').text('Записи участников'),$('<p>',{class:'admin__muted'}).text('Контакты доступны только хозяйке. Пометка «Нужно сообщить» означает, что изменение ещё не подтверждено участнику.'));
    const $form=$('<form>',{class:'admin__filters'}).append(input('q','Имя, телефон, email или номер','',{type:'search',maxlength:100}),input('day','День занятия','',{type:'date'}),input('status','Статус','',{choices:[['','Все'],['confirmed','Подтверждены'],['cancelled','Отменены']]}),$('<button>',{type:'submit',class:'button button--secondary'}).text('Найти'));
    const $list=$('<div>',{class:'admin__list','data-booking-list':''});$area.append($form,$list);
    if(sessionId)$area.append(button('Показать все занятия',()=>go('bookings')));
    async function draw(){
      $list.empty().append($('<p>',{role:'status'}).text('Смотрим записи…'));
      try{
        const query=Object.fromEntries(new FormData($form[0]));if(sessionId)query.session=sessionId;
        const result=await request('/bookings/search','POST',query);if(!$.contains(document,$list[0]))return;$list.empty();
        if(!result.bookings.length)$list.append($('<p>',{class:'empty-state'}).text('Записей по этим условиям нет.'));
        if(result.more)$list.append(notice('Показаны последние 200 записей. Уточните дату или поиск.'));
        for(const b of result.bookings){
          const $contacts=b.dataErasedAt?$('<p>',{class:'admin__muted'}).text('Контакты удалены по отзыву согласия или окончанию срока хранения.'):$('<p>',{class:'admin__contacts'}).append($('<a>',{href:`tel:${b.phone}`}).text(b.phone),' · ',$('<a>',{href:`mailto:${b.email}`}).text(b.email));
          const $card=$('<article>',{class:'admin__booking'}).append($('<span>',{class:'admin__tag'}).text(`${b.reference} · ${b.status==='confirmed'?'Подтверждена':'Отменена'}`),$('<h3>').text(nameOf(b.workshopId)),$('<p>').text(`${formatDate(b.startsAt)} · ${formatTime(b.startsAt)} · ${b.quantity} участн. · ${money(b.totalRub)}`),$('<p>').text(b.name),$contacts,b.comment?$('<p>').text(`Комментарий: ${b.comment}`):[]);
          const $actions=$('<div>',{class:'admin__actions'});
          async function action(kind){if(!confirm(kind==='cancel'?'Отменить эту бронь и освободить места? Сообщите участнику лично.':'Вы сообщили участнику об изменении?'))return;try{await request(`/bookings/${b.id}`,'POST',{action:kind,confirmed:true});await draw();data=await request('/data');}catch(error){$card.prepend(notice(error.message,true));}}
          if(b.notificationRequired)$card.append(notice('Нужно сообщить участнику об изменении.'),$('<p>',{class:'admin__muted'}).text(b.changeNote));
          if(b.notificationRequired)$actions.append(button('Участнику сообщили',()=>action('notified')));
          if(b.status==='confirmed')$actions.append(button('Отменить бронь',()=>action('cancel')));
          $list.append($card.append($actions));
        }
      }catch(error){$list.empty().append(notice(error.message,true),button('Повторить',draw));}
    }$form.on('submit',(e)=>{e.preventDefault();draw();});draw();
  }
  $(window).on('popstate',render);
  request('/session').then(async(session)=>{if(session.authenticated){csrf=session.csrf;await load();}else{login();if(!session.configured)$root.prepend(notice('Владелец ещё не настроен. Выполните настройку по инструкции в README проекта.',true));}}).catch((error)=>{$root.empty().append(notice(error.message,true),button('Повторить',()=>location.reload()));});
}
