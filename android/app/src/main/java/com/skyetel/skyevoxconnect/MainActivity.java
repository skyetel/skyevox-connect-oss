package com.skyetel.skyevoxconnect;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SkyeVoxNativePlugin.class);
        super.onCreate(savedInstanceState);

        // Enable WebRTC audio in WebView
        WebSettings webSettings = this.bridge.getWebView().getSettings();
        webSettings.setMediaPlaybackRequiresUserGesture(false);
    }
}
