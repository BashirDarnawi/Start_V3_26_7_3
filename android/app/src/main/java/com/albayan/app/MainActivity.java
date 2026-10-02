package com.albayan.app;

import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The app lock cannot cover the Recents (app switcher) preview, which kept the last
        // business screen readable. Android 13+ shows no preview; the user's own screenshots
        // still work (older versions would need FLAG_SECURE, which also blocks screenshots).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false);
        }
    }
}
