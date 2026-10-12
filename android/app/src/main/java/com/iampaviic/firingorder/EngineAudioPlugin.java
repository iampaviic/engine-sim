package com.iampaviic.firingorder;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.view.WindowManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Audio focus, headphone unplugging and screen keep-awake for the engine
 * sound. The sound itself is Web Audio inside the WebView; this plugin tells
 * the page when to pause and resume it (calls, other apps, unplugged
 * headphones) and keeps the screen on while the engine runs.
 */
@CapacitorPlugin(name = "EngineAudio")
public class EngineAudioPlugin extends Plugin implements AudioManager.OnAudioFocusChangeListener {

    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private boolean mixWithOthers = false;
    private boolean active = false;
    private boolean hasFocus = false;

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                JSObject data = new JSObject();
                data.put("reason", "deviceLost");
                notifyListeners("route", data);
            }
        }
    };

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        ContextCompat.registerReceiver(
            getContext(),
            noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    protected void handleOnDestroy() {
        abandonFocus();
        try {
            getContext().unregisterReceiver(noisyReceiver);
        } catch (IllegalArgumentException ignored) {
            // never registered
        }
    }

    @PluginMethod
    public void configure(PluginCall call) {
        mixWithOthers = call.getBoolean("mixWithOthers", false);
        if (active) {
            if (mixWithOthers) abandonFocus();
            else requestFocus();
        }
        call.resolve();
    }

    @PluginMethod
    public void setActive(PluginCall call) {
        active = call.getBoolean("on", false);
        if (active && !mixWithOthers) requestFocus();
        if (!active) abandonFocus();
        call.resolve();
    }

    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        final boolean on = call.getBoolean("on", false);
        getActivity()
            .runOnUiThread(() -> {
                if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                call.resolve();
            });
    }

    @SuppressWarnings("deprecation")
    private void requestFocus() {
        if (hasFocus || audioManager == null) return;
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_GAME)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attributes)
                    .setOnAudioFocusChangeListener(this)
                    .build();
            }
            result = audioManager.requestAudioFocus(focusRequest);
        } else {
            result = audioManager.requestAudioFocus(this, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        hasFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    @SuppressWarnings("deprecation")
    private void abandonFocus() {
        if (!hasFocus || audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
        else audioManager.abandonAudioFocus(this);
        hasFocus = false;
    }

    @Override
    public void onAudioFocusChange(int change) {
        JSObject data = new JSObject();
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            if (change == AudioManager.AUDIOFOCUS_LOSS) hasFocus = false;
            data.put("state", "began");
            notifyListeners("interruption", data);
        } else if (change == AudioManager.AUDIOFOCUS_GAIN) {
            hasFocus = true;
            data.put("state", "ended");
            data.put("shouldResume", true);
            notifyListeners("interruption", data);
        }
    }
}
