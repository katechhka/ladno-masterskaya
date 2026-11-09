let request;
async function fetchJSON(url) {
  if (import.meta.env.VITE_STATIC_DEMO === 'true') url = `${import.meta.env.BASE_URL}data/${url.endsWith('catalog') ? 'catalog' : 'schedule'}.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Не удалось загрузить расписание. Попробуйте ещё раз.');
    return await response.json();
  } finally { clearTimeout(timer); }
}

export function getScheduleData({ fresh = false } = {}) {
  if (fresh) request = undefined;
  if (!request) {
    request = Promise.all([fetchJSON('/api/catalog'), fetchJSON('/api/sessions')]).then(([catalog, schedule]) => {
      if (!Array.isArray(catalog.programs) || !Array.isArray(schedule.sessions)) throw new Error('Расписание временно недоступно.');
      const programs = new Map(catalog.programs.map((program) => [program.id, program]));
      const sessions = schedule.sessions.filter((session) => programs.has(session.workshopId)).map((session) => ({ ...session, program: programs.get(session.workshopId) }));
      return { programs, sessions, generatedAt: schedule.generatedAt };
    }).catch((error) => { request = undefined; throw error; });
  }
  return request;
}
