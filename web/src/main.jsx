import { Component } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// The last line of defence: React whites the whole page when a render crashes,
// which is a silent failure in front of the person least able to diagnose it.
// Any uncaught render error now shows plain words and a reload button instead,
// with the error text on screen to send to John.
class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 560, margin: '80px auto', fontFamily: 'inherit', color: '#1F3A5F', padding: '0 20px' }}>
        <h2 style={{ marginBottom: 8 }}>Something went wrong in the app</h2>
        <p style={{ marginBottom: 16 }}>
          Reload the page to carry on. If this repeats, send John a screenshot of this message.
        </p>
        <pre style={{ background: '#F2F5F8', padding: 12, borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {String(this.state.error?.message || this.state.error).slice(0, 500)}
        </pre>
        <button onClick={() => window.location.reload()}
          style={{ marginTop: 16, padding: '10px 18px', borderRadius: 8, border: 'none', background: '#1F3A5F', color: '#FFF', fontSize: 15, cursor: 'pointer' }}>
          Reload
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(<Boundary><App /></Boundary>);
