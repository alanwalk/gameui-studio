import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './components/studio-theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 容器');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
