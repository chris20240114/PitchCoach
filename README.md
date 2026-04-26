# PitchCoach

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
- Hackathon judge
- Technical interviewer
- Product manager
- Investor
- Professor
- Class presentation audience

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

1. Select "Hackathon Pitch Coach" mode
2. Deliver a 60-second pitch
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
Audio Input → Speech-to-Text → Transcript Analysis
Video Input → Visual Heuristics → Delivery Signals
Combined Analysis → Coach Response → TTS → Avatar Animation
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
- Python 3.11+
- Webcam and microphone
- Internet connection for LLM processing

### Quick Start
```bash
# Clone the repository
git clone https://github.com/chris20240114/PitchCoach.git
cd PitchCoach

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the application
python app.py
```

### Dependencies
- Speech recognition library
- Computer vision (OpenCV/MediaPipe)
- LLM integration (OpenAI/Anthropic)
- Text-to-speech engine
- Web framework (Flask/FastAPI)

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



