import { render } from 'preact';
import { PluginTab } from '../src/plugin-tab';
import { token } from '../src/api';
import '../src/style.css';
const q = new URLSearchParams(location.search);
document.documentElement.dataset.theme = q.get('theme') ?? 'light';
token.set('synthetic-browser-fixture-not-a-secret');
render(<PluginTab tab={{ plugin: q.get('plugin') ?? 'dynamic-tools', id: 'settings', title: 'Dynamic tools fixture', placement: 'sidebar', src: '/p/' + (q.get('plugin') ?? 'dynamic-tools') + '/tab' }}/>, document.getElementById('root')!);
