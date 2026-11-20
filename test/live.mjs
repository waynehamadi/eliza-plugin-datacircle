// Each action's own handler on the live API, as elizaOS calls it (its parameters in options.parameters): its four calls and the
// answers a model's mistakes get. Run from a project that installed the package: node test/live.mjs
import datacirclePlugin, { createDatacirclePlugin, datacircleActions, GTM_CONTEXT, APIS, BEST_PLANS, PLANS, PROVIDER } from '@datacircle/plugin-datacircle';

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (!ok) failed++;
};
const byName = (plugin) => Object.fromEntries(plugin.actions.map((a) => [a.name, a]));
const actions = byName(datacirclePlugin);
// The handler as elizaOS calls it: runtime, message, state, then the options that hold the validated parameters.
const run = async (name, parameters, plugin = datacirclePlugin) => {
  const result = await byName(plugin)[name].handler({}, { content: { text: '' } }, undefined, { parameters });
  const answer = JSON.parse(result.text);
  return { result, answer };
};

check('plugin', datacirclePlugin.name === 'datacircle' && datacirclePlugin.contexts[0] === GTM_CONTEXT && Object.keys(actions).join(' ') === [APIS, BEST_PLANS, PLANS, PROVIDER].join(' ')
  && Object.values(actions).every((a) => a.roleGate.minRole === 'GUEST' && a.contexts.includes(GTM_CONTEXT) && a.parameters.length > 0),
  Object.keys(actions).join(' '));
const registered = [];
await datacirclePlugin.init({}, { contexts: { tryRegister: (definition) => registered.push(definition.id) } });
check('init registers gtm_apis', registered.join() === GTM_CONTEXT, registered.join());
check('every action validates', (await Promise.all(Object.values(actions).map((a) => a.validate({}, {})))).every(Boolean), 'true');

let { result, answer: r } = await run(APIS, {});
check('list_apis', result.success && r.total > 100 && r.apis.length === 20 && r.apis[0].slug && result.data.answer.total === r.total && result.promptDataMode === 'replace-data',
  `total ${r.total}, first ${r.apis[0]?.slug}`);
({ answer: r } = await run(APIS, { query: 'email', limit: '3' }));
check('list_apis email, limit as a string', r.apis?.length === 3 && r.apis.every((a) => /email/i.test(a.api + a.slug)) && !r.note, r.apis?.map((a) => a.slug).join(', '));
({ answer: r } = await run(APIS, { query: null, limit: null }));
check('list_apis nulls', r.apis?.length === 20 && !r.note, `${r.apis?.length} apis`);
({ answer: r } = await run(APIS, { query: 'Bright Data' }));
check('list_apis provider name', typeof r.note === 'string' && r.note.includes(PLANS) && r.note.includes(PROVIDER), r.note);

({ result, answer: r } = await run(BEST_PLANS, { slug: 'email-finder', limit: 3 }));
check('best_plans', result.success && r.plans.length === 3 && r.plans[0].rank === 1 && typeof r.plans[0].score === 'number' && r.plans[0].page && !('aggregators' in r.plans[0]),
  `${r.api}: ${r.plans.map((p) => `${p.rank}. ${p.provider} ${p.score}`).join(' / ')}`);
({ answer: r } = await run(BEST_PLANS, { slug: 'Email Finder', limit: 99 }));
check('best_plans name, limit 99', r.plans?.length === 50 && r.slug === 'email-finder', `${r.plans?.length} plans`);
({ answer: r } = await run(BEST_PLANS, { slug: 'email-finder', limit: '5' }));
check('best_plans limit as a string', r.plans?.length === 5, `${r.plans?.length} plans`);
({ result, answer: r } = await run(BEST_PLANS, { slug: 'bright-data' }));
check('best_plans unknown slug', !result.success && result.error === r.error && r.error.startsWith('no API has the slug bright-data') && r.error.includes(PLANS) && !r.slugs, r.error);
({ result, answer: r } = await run(BEST_PLANS, { slug: null }));
check('best_plans no slug', !result.success && r.error.startsWith("Give an API's slug"), r.error);

({ answer: r } = await run(PLANS, { query: 'bright data', sort: 'price', limit: 5 }));
check('search_plans', r.total > 0 && r.plans.length === 5 && r.plans.every((p) => /bright data/i.test(p.provider)) && r.plans[0].perThousand <= r.plans[4].perThousand,
  `total ${r.total}, cheapest ${r.plans[0]?.perThousand}`);
({ answer: r } = await run(PLANS, { api: 'email-finder', limit: 2, offset: 1 }));
check('search_plans api offset', r.plans.length === 2 && r.plans[0].rank === 2, r.plans.map((p) => `${p.rank}. ${p.provider}`).join(' / '));
({ answer: r } = await run(PLANS, { api: 'Bright Data', query: null, sort: null, limit: null, offset: null }));
check('search_plans provider as api, nulls', r.total > 0 && r.plans.length === 10 && r.note?.startsWith('No API is named'), `total ${r.total}: ${r.note}`);
({ answer: r } = await run(PLANS, { query: 'bright-data' }));
check('search_plans slug as query', r.total > 0 && r.note?.includes('"bright data"'), `total ${r.total}: ${r.note}`);
({ answer: r } = await run(PLANS, { offset: -3, limit: 0 }));
check('search_plans out of range: the defaults', r.plans?.length === 10, `${r.plans?.length} plans`);
({ answer: r } = await run(PLANS, { limit: '2', offset: '1' }));
check('search_plans numbers as strings', r.plans?.length === 2 && r.offset === 1, `${r.plans?.length} plans from ${r.offset}`);
({ result, answer: r } = await run(PLANS, { sort: 'cheapest' }));
check('search_plans refused sort: the API\'s words', !result.success && r.error === 'sort must be one of: score, provider, price', r.error);

({ result, answer: r } = await run(PROVIDER, { slug: 'Bright Data' }));
check('provider', result.success && r.slug === 'bright-data' && r.total > 10 && r.ranked > 0 && r.apis[0].rank <= r.apis[1].rank && r.apis[0].best?.plan,
  `${r.provider}: ${r.total} APIs, ranked on ${r.ranked}, best ${r.apis[0].api} #${r.apis[0].rank}`);
({ answer: r } = await run(PROVIDER, { slug: 'bright-data' }));
check('provider slug', r.slug === 'bright-data', r.slug);
({ result, answer: r } = await run(PROVIDER, { slug: 'nobody-x' }));
check('provider unknown', !result.success && r.error.startsWith('no provider has the slug nobody-x'), r.error);

// A host's own fetch, and each call's User-Agent.
const seen = [];
const traced = createDatacirclePlugin({ fetch: (url, init) => (seen.push([String(url), init.headers['User-Agent']]), fetch(url, init)) });
await run(BEST_PLANS, { slug: 'serp', limit: 1 }, traced);
check('fetch option', seen.length === 1 && seen[0][0] === 'https://api.datacircle.dev/v1/apis/serp/best?limit=1' && seen[0][1] === 'datacircle-eliza/0.1.1', seen.flat().join(' '));
check('datacircleActions', datacircleActions().map((a) => a.name).join(' ') === Object.keys(actions).join(' '), 'the same four');

// An aborted call stops.
const controller = new AbortController();
controller.abort();
const stopped = await actions[APIS].handler({}, {}, undefined, { parameters: {}, abortSignal: controller.signal }).then(() => false, () => true);
check('abort', stopped, String(stopped));

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
