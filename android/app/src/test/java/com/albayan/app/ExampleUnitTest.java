package com.albayan.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Minimal JVM test that verifies the configured application identifier. */
public class ExampleUnitTest {

    @Test
    public void applicationIdIsStable() {
        assertEquals("com.albayan.app", BuildConfig.APPLICATION_ID);
    }
}
