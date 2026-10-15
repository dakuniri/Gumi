import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, pageFromHash } from './App';
import './styles/global.css';

const page = pageFromHash(window.location.hash);
document.body.dataset.page = page;
document.title = page === 'settings' ? 'Gumi 設定' : 'Gumi';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App page={page} />
  </StrictMode>,
);
