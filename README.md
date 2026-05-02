# PitchCoach

Live site: https://pitchcoach-presentation.onrender.com/

## Overview

PitchCoach is an embodied AI presentation coach that watches and listens while someone practices a pitch, speech, or interview answer. Unlike traditional feedback tools that analyze uploaded videos, PitchCoach feels like a live human coach in the room. It responds naturally with nods, interruptions, follow-up questions, and specific feedback based on both content and delivery.

The core experience: Stand in front of a webcam and give a 30-60 second pitch. The AI avatar listens in real time, reacts during your presentation, and provides actionable coaching afterward.

## Key Features

### 1. Live Coaching Mode
- Real-time listening with natural interruptions
- Avatar reactions (nodding, looking confused, etc.)
- Spontaneous feedback during your presentation

### 2. Audience Simulation
Choose from different audience types:
- General audience
- Technical audience
- Executive audience
- Beginner audience
- Evaluator or judge
- Investor
- Custom

Each audience type provides tailored feedback style and questions.

### 3. Visual Feedback
Webcam analysis detects:
- Eye contact consistency
- Face visibility and positioning
- Posture and head position
- Distance from camera
- Lighting and background issues

### 4. Audio Feedback
Microphone analysis measures:
- Speaking pace and volume
- Filler word usage
- Pause frequency and length
- Sentence structure and rambling

### 5. Content Analysis
LLM-powered evaluation of:
- Problem clarity
- User specificity
- Solution explanation
- Evidence and impact
- Call to action strength

## Demo Flow

1. Choose a presentation type, audience, and live coaching intensity
2. Deliver a 60-second practice segment
3. Avatar listens and reacts in real time
4. Coach asks one follow-up question
5. Provide your answer
6. Receive comprehensive feedback and suggested rewrites

## Technical Architecture

### Frontend
- Webcam preview and controls
- Animated avatar/coach panel
- Live transcript display
- Feedback dashboard
- Start/stop/retry functionality

### Backend
- Real-time speech-to-text processing
- Transcript analysis with LLM
- Vision-based signal extraction
- Coaching response generation
- Text-to-speech synthesis

### Data Flow
```
Audio Input -> Speech-to-Text -> Transcript Analysis
Video Input -> Visual Heuristics -> Delivery Signals
Combined Analysis -> Coach Response -> TTS -> Avatar Animation
```

## Why This Matters

Presentation coaching requires voice, face, and spatial awareness. Traditional tools miss:
- Eye contact avoidance
- Speaking pace issues
- Nervous body language
- Contradictory gestures
- Timing and pauses

PitchCoach combines all three modalities for truly comprehensive feedback.

## Installation & Setup

### Prerequisites
- A modern Chromium-based browser for the best speech recognition support
- Webcam and microphone permissions
- Node.js 18+ and npm

### Quick Start
```bash
# From the project folder
npm run dev

# Open in your browser
http://localhost:3000
```

No `npm install` is required for the current dependency-free server.

### Current MVP
- Browser speech recognition for live transcript capture
- Browser speech synthesis for spoken coach feedback
- Webcam-based visual heuristics plus a face tracking overlay for camera presence, eye movement, face position, lighting, and head movement
- Live microphone analysis for volume, vocal energy, pitch range, and pause rhythm
- Session timeline with timestamped transcript chunks, live coach events, audio summary, and visual samples
- Deterministic pitch scoring for pace, filler words, problem clarity, user specificity, demo clarity, impact, and call to action
- General-purpose presentation context for pitches, class presentations, interviews, sales demos, team updates, teaching, and speeches
- Audience modes for general, technical, executive, beginner, evaluator, and investor audiences
- Live coaching intensity modes: quiet, balanced, and interrupt me
- Upload support for transcript, caption, audio, and video practice files

### LLM Feedback Integration Point
The browser now has two input paths:
- Live practice captures transcript, duration, and visual signals.
- Upload practice accepts a transcript/caption file, or media plus a pasted transcript.

Both paths send the same normalized payload to `POST /api/feedback`, including presentation context and a session timeline when available. Keep the LLM API key on the backend, not in `app.js`.

To connect an LLM provider, create `.env` from `.env.example`:
```bash
cp .env.example .env
```

Then set:
```bash
GEMINI_API_KEY=your_key
GEMINI_MODEL=gemini-2.5-flash
```

The backend prefers Gemini when `GEMINI_API_KEY` is set. It calls Gemini's `generateContent` API with a structured JSON schema for `coachResponse`, `avatarState`, delivery metrics, content metrics, suggested rewrite, and follow-up question. If no AI key is set or the API call fails, the server returns local fallback feedback so the demo still works.

You can still compare OpenAI later by setting `OPENAI_API_KEY` and `OPENAI_MODEL`; Gemini takes priority when both keys are present.

## Usage Examples

### Bad Pitch Example
User: "So basically we made an AI thing that uses vision and audio and it's kind of like a coach, and there are a lot of use cases..."

Coach interrupts: "Pause. I'm hearing features, but not the problem. Start with who struggles and why."

### Improved Pitch
User: "Students practicing presentations usually get feedback too late. Our coach watches and listens in real time, then gives specific delivery and content feedback before the real presentation."

Coach: "Much better. Now add one concrete example of the feedback I can give."

## Feedback Dashboard

### Delivery Metrics
- Speaking pace: slightly fast
- Eye contact: inconsistent
- Filler words: 9
- Pauses: too few
- Energy: strong opening, weaker ending

### Content Scores
- Clear problem: 6/10
- Specific user: 5/10
- Demo clarity: 8/10
- Call to action: missing

### Suggested Rewrite
"Instead of starting with the tech stack, start with the person you are helping."

## Contributing

We welcome contributions! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

Areas for contribution:
- Improved computer vision algorithms
- Better LLM prompts for coaching
- Additional audience types
- Enhanced avatar animations

## License

MIT License - see LICENSE file for details.

## Roadmap

- [ ] MVP with basic speech-to-text and LLM feedback
- [ ] Avatar integration with simple expressions
- [ ] Webcam visual analysis
- [ ] Multiple audience types
- [ ] Full-duplex interruption mode
- [ ] Mobile app version

## Contact

For questions or feedback, reach out to the maintainers or open an issue on GitHub.
