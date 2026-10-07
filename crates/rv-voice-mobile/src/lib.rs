//! The Android voice engine's noise remover (apps/mobile/modules/voice): RNNoise,
//! as the desktop sidecar runs it (apps/desktop/voice/src/audio.rs), over JNI.
//! `com.rocketvibe.voice.Denoiser` holds one handle for the process; each 10 ms
//! frame of 48 kHz mono 16-bit samples is cleaned in place, and its voice
//! probability (0 to 1) tells who speaks.
use jni::JNIEnv;
use jni::objects::{JClass, JShortArray};
use jni::sys::{jfloat, jlong};
use nnnoiseless::DenoiseState;

/// 10 ms at 48 kHz.
pub const FRAME: usize = nnnoiseless::FRAME_SIZE;

pub struct Denoiser {
    state: Box<DenoiseState<'static>>,
    input: Vec<f32>,
    output: Vec<f32>,
}

impl Default for Denoiser {
    fn default() -> Self {
        Self {
            state: DenoiseState::new(),
            input: vec![0.0; FRAME],
            output: vec![0.0; FRAME],
        }
    }
}

impl Denoiser {
    /// Cleans one frame in place; its voice probability. Another length is left as is.
    pub fn process(&mut self, frame: &mut [i16]) -> f32 {
        if frame.len() != FRAME {
            return 0.0;
        }
        for (input, sample) in self.input.iter_mut().zip(frame.iter()) {
            *input = *sample as f32;
        }
        let voice = self.state.process_frame(&mut self.output, &self.input);
        for (sample, output) in frame.iter_mut().zip(&self.output) {
            *sample = output.clamp(-32_768.0, 32_767.0) as i16;
        }
        voice
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_Denoiser_create(
    _env: JNIEnv,
    _class: JClass,
) -> jlong {
    Box::into_raw(Box::<Denoiser>::default()) as jlong
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_rocketvibe_voice_Denoiser_process(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
    samples: JShortArray,
) -> jfloat {
    if handle == 0 {
        return 0.0;
    }
    // SAFETY: `handle` comes from `create` and is never destroyed while in use:
    // Denoiser.kt creates one for the process and calls it from the audio thread only.
    let denoiser = unsafe { &mut *(handle as *mut Denoiser) };
    let mut frame = [0i16; FRAME];
    if env.get_short_array_region(&samples, 0, &mut frame).is_err() {
        return 0.0;
    }
    let voice = denoiser.process(&mut frame);
    if env.set_short_array_region(&samples, 0, &frame).is_err() {
        return 0.0;
    }
    voice
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_is_cleaned_in_place_and_others_are_left() {
        let mut denoiser = Denoiser::default();
        // A fan's rumble (low-passed noise): after half a second RNNoise has
        // learnt it, takes nearly all of it away, and hears no voice in it.
        let (mut seed, mut rumble) = (1u32, 0f32);
        let mut noise = [0i16; FRAME];
        let (mut before, mut after, mut voices) = (0f64, 0f64, 0f32);
        for round in 0..300 {
            for sample in noise.iter_mut() {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                rumble = rumble * 0.95 + ((seed >> 16) as u16 as i16) as f32 / 16.0 * 0.05;
                *sample = (rumble * 4.0) as i16;
            }
            let energy = noise.iter().map(|&s| (s as f64).powi(2)).sum::<f64>();
            let voice = denoiser.process(&mut noise);
            if round >= 50 {
                before += energy;
                after += noise.iter().map(|&s| (s as f64).powi(2)).sum::<f64>();
                voices += voice;
            }
        }
        assert!(voices / 250.0 < 0.1, "{voices}");
        assert!(after < before / 1000.0, "{before} {after}");
        let mut short = [7i16; 10];
        assert_eq!(denoiser.process(&mut short), 0.0);
        assert_eq!(short, [7; 10]);
    }
}
