import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
function App(){const [message,setMessage]=React.useState('Could not load records. Please try again later.');return <main><h1>Records</h1><button onClick={()=>setMessage('Retry failed. Could not load records.')}>Refresh</button><p role="alert">{message}</p><section>{'Synthetic record '.repeat(24)}</section></main>}
createRoot(document.getElementById('root')).render(<App/>);
