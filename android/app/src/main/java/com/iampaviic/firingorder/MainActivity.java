package com.iampaviic.firingorder;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // plugins that live in this app rather than in an npm package
        registerPlugin(EngineAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
